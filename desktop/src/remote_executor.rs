//! Target-aware remote execution over the physical SSH transport.
//! Target-aware remote execution: SSH endpoint and host/Docker executors.
//!
//! [`SshEndpoint`] describes how the physical SSH transport reaches the dev
//! server. [`HostExecutor`] runs commands directly on that host; [`DockerExecutor`]
//! wraps every target operation in `docker exec -i` against a pinned container.
//! [`preflight_docker`] discovers and inspects the container, probes the user,
//! and returns either a ready [`DockerExecutor`] or pending risk acknowledgements.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;

use crate::bridge::{CommandOutput, SshCommand, SshProxy, SshTransport};
use crate::docker_target::{
    parse_container_list, parse_inspect, persistence_facts, resolve_exact_running, shell_join,
    PersistenceClassification, ResolvedDockerTarget, CONTAINER_LIST_FORMAT,
};
use crate::remote_connection::{PendingRisk, PreflightPhase, RiskKind};
use crate::remote_profile::{
    ephemeral_risk_fingerprint, root_risk_fingerprint, ExecutionTargetProfile, RemoteProfile,
};

/// Physical SSH reachability for the dev server (destination + optional port).
///
/// Not yet wired into the production connection driver — `preflight_docker`
/// currently builds its host `SshCommand` from the profile. This struct exists
/// so the endpoint/executor split described in the plan is type-visible and
/// ready for the final wiring.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshEndpoint {
    pub destination: String,
    pub port: Option<u16>,
}

impl SshEndpoint {
    #[allow(dead_code)]
    pub fn command(&self, remote_root: impl Into<String>) -> SshCommand {
        SshCommand {
            destination: self.destination.clone(),
            port: self.port,
            remote_root: remote_root.into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
            raw_remote_command: None,
        }
    }
}

pub trait RemoteExecutor: Send + Sync {
    fn run_script(
        &self,
        script: String,
    ) -> Pin<Box<dyn Future<Output = io::Result<CommandOutput>> + Send>>;

    fn upload(
        &self,
        destination: String,
        data: Vec<u8>,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>>;

    fn spawn_proxy(
        &self,
        server_path: String,
        env: Vec<(String, String)>,
    ) -> Pin<Box<dyn Future<Output = io::Result<SshProxy>> + Send>>;

    /// Returns the configured remote root path.
    /// Required by the executor contract; not yet called from the production
    /// connection driver but used in executor unit tests.
    #[allow(dead_code)]
    fn remote_root(&self) -> &str;
}

#[derive(Clone)]
pub struct HostExecutor {
    transport: Arc<dyn SshTransport>,
    command: SshCommand,
}

impl HostExecutor {
    pub fn new(transport: Arc<dyn SshTransport>, command: SshCommand) -> Self {
        Self { transport, command }
    }

    #[allow(dead_code)]
    pub fn command(&self) -> &SshCommand {
        &self.command
    }
}

impl RemoteExecutor for HostExecutor {
    fn run_script(
        &self,
        script: String,
    ) -> Pin<Box<dyn Future<Output = io::Result<CommandOutput>> + Send>> {
        self.transport.run_command(self.command.clone(), &script)
    }

    fn upload(
        &self,
        destination: String,
        data: Vec<u8>,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>> {
        self.transport
            .upload_file(self.command.clone(), &destination, data)
    }

    fn spawn_proxy(
        &self,
        server_path: String,
        env: Vec<(String, String)>,
    ) -> Pin<Box<dyn Future<Output = io::Result<SshProxy>> + Send>> {
        let mut command = self.command.clone();
        command.server_path = server_path;
        command.extra_env.extend(env);
        self.transport.spawn_proxy(command)
    }

    fn remote_root(&self) -> &str {
        &self.command.remote_root
    }
}

pub enum PreflightOutcome {
    Ready(DockerExecutor),
    AwaitingAcknowledgement {
        /// Executor kept for resumption after acknowledgement; not read in
        /// the current test-only call path.
        #[allow(dead_code)]
        executor: DockerExecutor,
        phase: PreflightPhase,
        pending_risks: Vec<PendingRisk>,
    },
}

fn classify_command_failure(output: &CommandOutput, context: &str) -> io::Error {
    let detail = output.stderr.lines().next().unwrap_or("command failed");
    io::Error::other(format!("{context}: {detail}"))
}

pub async fn preflight_docker(
    transport: Arc<dyn SshTransport>,
    profile: &RemoteProfile,
    on_phase: impl Fn(PreflightPhase),
) -> io::Result<PreflightOutcome> {
    let ExecutionTargetProfile::DockerContainer {
        container_name,
        user,
        workdir,
        pantoken_root,
    } = &profile.execution_target
    else {
        return Err(io::Error::other(
            "Docker preflight requires a Docker profile",
        ));
    };
    let host_command = SshCommand::from(profile);

    on_phase(PreflightPhase::CheckingDockerAccess);
    let version = transport
        .run_command(
            host_command.clone(),
            "docker version --format '{{.Client.Version}}'",
        )
        .await?;
    if !version.is_success() {
        return Err(classify_command_failure(
            &version,
            "Docker CLI unavailable or permission denied",
        ));
    }

    on_phase(PreflightPhase::LocatingContainer);
    let list_command = shell_join(&[
        "docker".into(),
        "container".into(),
        "ls".into(),
        "-a".into(),
        "--format".into(),
        CONTAINER_LIST_FORMAT.into(),
    ]);
    let listed = transport
        .run_command(host_command.clone(), &list_command)
        .await?;
    if !listed.is_success() {
        return Err(classify_command_failure(
            &listed,
            "could not list Docker containers",
        ));
    }
    let record = resolve_exact_running(
        &parse_container_list(&listed.stdout).map_err(io::Error::other)?,
        container_name,
    )
    .map_err(io::Error::other)?;

    on_phase(PreflightPhase::InspectingIdentity);
    let inspect_command = shell_join(&[
        "docker".into(),
        "container".into(),
        "inspect".into(),
        record.id.clone(),
    ]);
    let inspected = transport
        .run_command(host_command.clone(), &inspect_command)
        .await?;
    if !inspected.is_success() {
        return Err(classify_command_failure(
            &inspected,
            "could not inspect Docker container",
        ));
    }
    let inspect = parse_inspect(&inspected.stdout).map_err(io::Error::other)?;
    if inspect.id != record.id
        || !inspect.state.running
        || inspect.state.paused
        || inspect.state.restarting
        || inspect.state.dead
    {
        return Err(io::Error::other(
            "container stopped or was replaced during preflight",
        ));
    }

    let mut target = ResolvedDockerTarget {
        configured_name: container_name.clone(),
        container_id: inspect.id.clone(),
        user: user.clone(),
        workdir: workdir.clone(),
        pantoken_root: pantoken_root.clone(),
        env: Vec::new(),
    };
    let executor = DockerExecutor::new(transport, host_command, target.clone());

    on_phase(PreflightPhase::CheckingUserPermissions);
    let workdir_probe = workdir.as_deref().unwrap_or(pantoken_root);
    let identity_script = format!(
        "uid=$(id -u) && gid=$(id -g) && home=${{HOME:-}} && \
         test -n \"$home\" && command -v sh >/dev/null 2>&1 && \
         mkdir -p {root} && test -w {root} && test -d {work} && test -w {work} && \
         printf '%s|%s|%s\\n' \"$uid\" \"$gid\" \"$home\"",
        root = crate::docker_target::posix_quote(pantoken_root),
        work = crate::docker_target::posix_quote(workdir_probe),
    );
    let identity = executor.run_script(identity_script).await?;
    if !identity.is_success() {
        return Err(classify_command_failure(
            &identity,
            "container user, shell, Pantoken root, or workdir is unavailable",
        ));
    }
    let fields: Vec<_> = identity.stdout.trim().split('|').collect();
    if fields.len() != 3 {
        return Err(io::Error::other(
            "container identity probe returned malformed output",
        ));
    }
    let uid: u64 = fields[0]
        .parse()
        .map_err(|_| io::Error::other("container identity probe returned invalid UID"))?;
    let gid: u64 = fields[1]
        .parse()
        .map_err(|_| io::Error::other("container identity probe returned invalid GID"))?;

    on_phase(PreflightPhase::CheckingPersistence);
    let facts = persistence_facts(pantoken_root, &inspect.mounts).map_err(io::Error::other)?;
    let mut pending_risks = Vec::new();
    let root_fingerprint =
        root_risk_fingerprint(1, &profile.id, container_name, &inspect.id, user, uid, gid);
    if uid == 0
        && profile.risk_acknowledgements.root_fingerprint.as_deref()
            != Some(root_fingerprint.as_str())
    {
        pending_risks.push(PendingRisk {
            id: "rootExecution".into(),
            kind: RiskKind::RootExecution,
            fingerprint: root_fingerprint,
            title: "Run Pantoken as root in this container?".into(),
            explanation: "The selected Docker user resolves to UID 0. Docker access is itself a high-privilege host boundary, and container root or broad mounts can weaken isolation.".into(),
            consequences: "Pantoken and polytoken processes will have root privileges inside the container and may modify mounted resources.".into(),
            continue_label: "Allow root for this container".into(),
        });
    }
    let classification = match facts.classification {
        PersistenceClassification::PersistentBind => "persistentBind",
        PersistenceClassification::PersistentVolume => "persistentVolume",
        PersistenceClassification::EphemeralTmpfs => "tmpfs",
        PersistenceClassification::EphemeralWritableLayer => "writableLayer",
    };
    let ephemeral = matches!(
        facts.classification,
        PersistenceClassification::EphemeralTmpfs
            | PersistenceClassification::EphemeralWritableLayer
    );
    let ephemeral_fingerprint = ephemeral_risk_fingerprint(
        1,
        &profile.id,
        container_name,
        &inspect.id,
        pantoken_root,
        classification,
        &facts.mount_destination,
        &facts.mount_type,
        &facts.read_write,
        &facts.backing_identity_hash,
    );
    if ephemeral
        && profile
            .risk_acknowledgements
            .ephemeral_fingerprint
            .as_deref()
            != Some(ephemeral_fingerprint.as_str())
    {
        pending_risks.push(PendingRisk {
            id: "ephemeralData".into(),
            kind: RiskKind::EphemeralData,
            fingerprint: ephemeral_fingerprint,
            title: "Pantoken data is not on persistent storage".into(),
            explanation: "Docker stop/start normally retains the writable layer, but this Pantoken root is on tmpfs or the container writable layer.".into(),
            consequences: "Container removal, recreation, or rebuild can lose the Pantoken runtime, session state, and Pantoken-managed polytoken XDG data.".into(),
            continue_label: "Use non-persistent storage".into(),
        });
    }

    target.env.extend([
        ("PANTOKEN_REMOTE_ROOT".into(), pantoken_root.clone()),
        ("PANTOKEN_SERVE_MODE".into(), "stdio-proxy".into()),
    ]);
    let executor = DockerExecutor::new(executor.transport, executor.host_command, target);
    if pending_risks.is_empty() {
        Ok(PreflightOutcome::Ready(executor))
    } else {
        Ok(PreflightOutcome::AwaitingAcknowledgement {
            executor,
            phase: PreflightPhase::CheckingPersistence,
            pending_risks,
        })
    }
}

#[derive(Clone)]
pub struct DockerExecutor {
    transport: Arc<dyn SshTransport>,
    host_command: SshCommand,
    target: ResolvedDockerTarget,
}

impl DockerExecutor {
    pub fn new(
        transport: Arc<dyn SshTransport>,
        host_command: SshCommand,
        target: ResolvedDockerTarget,
    ) -> Self {
        Self {
            transport,
            host_command,
            target,
        }
    }

    /// Returns the resolved Docker target (pinned ID, user, etc.).
    #[allow(dead_code)]
    pub fn target(&self) -> &ResolvedDockerTarget {
        &self.target
    }

    /// Run a host-side Docker command (discovery/inspection only).
    #[allow(dead_code)]
    pub fn run_host_command(
        &self,
        words: Vec<String>,
    ) -> Pin<Box<dyn Future<Output = io::Result<CommandOutput>> + Send>> {
        self.transport
            .run_command(self.host_command.clone(), &shell_join(&words))
    }
}

impl RemoteExecutor for DockerExecutor {
    fn run_script(
        &self,
        script: String,
    ) -> Pin<Box<dyn Future<Output = io::Result<CommandOutput>> + Send>> {
        let command = shell_join(&self.target.command_words(&script));
        self.transport
            .run_command(self.host_command.clone(), &command)
    }

    fn upload(
        &self,
        destination: String,
        data: Vec<u8>,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>> {
        let words = match self.target.upload_words(&destination) {
            Ok(words) => words,
            Err(error) => return Box::pin(async move { Err(io::Error::other(error)) }),
        };
        let command = shell_join(&words);
        self.transport
            .run_command_with_stdin(self.host_command.clone(), command, data)
    }

    fn spawn_proxy(
        &self,
        server_path: String,
        env: Vec<(String, String)>,
    ) -> Pin<Box<dyn Future<Output = io::Result<SshProxy>> + Send>> {
        let mut target = self.target.clone();
        target.env.extend(env);
        let words = match target.proxy_words(&server_path) {
            Ok(words) => words,
            Err(error) => return Box::pin(async move { Err(io::Error::other(error)) }),
        };
        let mut command = self.host_command.clone();
        command.raw_remote_command = Some(shell_join(&words));
        command.remote_root = target.pantoken_root;
        command.extra_env.clear();
        self.transport.spawn_proxy(command)
    }

    fn remote_root(&self) -> &str {
        &self.target.pantoken_root
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::fake::{FakeScenario, FakeSshTransport};
    use crate::docker_target::ResolvedDockerTarget;

    fn command() -> SshCommand {
        SshCommand {
            destination: "fake".into(),
            port: None,
            remote_root: "/host/root".into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
            raw_remote_command: None,
        }
    }

    fn target() -> ResolvedDockerTarget {
        ResolvedDockerTarget {
            configured_name: "api".into(),
            container_id: "sha256:full-id".into(),
            user: "1000:1000".into(),
            workdir: Some("/workspace".into()),
            pantoken_root: "/data/pantoken".into(),
            env: Vec::new(),
        }
    }

    #[tokio::test]
    async fn host_mode_executor_regression() {
        let transport = Arc::new(FakeSshTransport::new(FakeScenario::healthy()));
        let executor = HostExecutor::new(transport, command());
        assert!(executor
            .run_script("echo ok".into())
            .await
            .unwrap()
            .is_success());
        executor
            .upload("/tmp/file".into(), vec![0, 1, 255])
            .await
            .unwrap();
        assert_eq!(executor.remote_root(), "/host/root");
    }

    #[tokio::test]
    async fn docker_upload_targets_container_only_and_preserves_bytes() {
        let transport = Arc::new(FakeSshTransport::new(FakeScenario::healthy()));
        let executor = DockerExecutor::new(transport.clone(), command(), target());
        let bytes = vec![0, 1, 2, 255, b'\n'];
        executor
            .upload("/data/a '$; file".into(), bytes.clone())
            .await
            .unwrap();
        let commands = transport.stdin_commands();
        let guard = commands.lock().unwrap();
        let (command, actual) = guard.first().expect("upload recorded");
        assert!(command.contains("docker exec -i"));
        assert!(command.contains("sha256:full-id"));
        assert!(command.contains("cat >"));
        assert_eq!(actual, &bytes);
    }
}

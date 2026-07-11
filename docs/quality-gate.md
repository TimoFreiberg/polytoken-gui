This repo is fully agent built and the code is all also only reviewed by agents. So all the quality must come from agent tooling and the quality of my feature descriptions. 
The desktop GUI must Faithfully implement all the features that the PolyToken TUI has. 
The mobile GUI can adapt to the different form factor, but all the core features should be available in some way. 
Data input by the user should never be lost by the GUI, if at all possible. This mostly concerns the prompt composer data, but Stuff like the model chosen in the new session, draft view, the effort level, the facet that should all also be stored. 
The GUI state should not surprisingly change without user input. Except for a small set of exceptions, which is agent tool use that shows the user stuff like the question and answer form or the plan that's being proposed. 
Activity in sessions that are not currently focused Must never interfere with the rest of the app state, with the exception of visual info in the sidebar so the title of the session can have a little notification yellow dot displayed next to it it might make subtly flash or whatever and of course desktop notifications for incoming questions are allowed (but notifications should be configurable) (And being in the new session draft view counts as not having any other session focused. )
Any of the overlay type displays like permission pop-ups, question and answer forms, or plan pop-ups must never prevent the user from doing whatever they might have currently been doing. So it might pop up over the prompt composer, but it should always be possible to Continue typing the prompts by, for example, minimizing question and answer form.
In this case it would probably be even better if the question and answer form was displayed  above the composer instead of on top of the composer, So anyone that's currently typing something into the composer isn't completely interrupted. That sentence probably warrants a discussion. I just came up with that right now. I'm not sure if That would have more drawbacks that I'm not thinking of right now.
Anything set in the GUI that isn't persisted as part of the agent backend like which project in the sidebar is expanded or collapsed which session is archived what's typed into the composer of a new session view, All of that should be persisted in local storage of the of the GUI. At a best effort basis this isn't a transactional database, but it is always nice if you don't have to redo work you were doing. On the other hand, it should not be possible to brick your installation and require manual editing of config files.
So it should not be possible to, for example, minimize the sidebar by dragging it to a width where it is impossible to for some reason impossible to get a handle on the dragger and make it wider again.

Um about uh the server and I guess reliability and in memory storage the server should be written with a focus on performance and reliability It should have thorough error handling and optimally never panic. I guess if there's truly invalid config it is possible to crash on startup but even if for example the poly token binary disappears while the server is running.
I would prefer to see that in the GUI instead of like button clicks in the GUI not doing anything anymore.

It's written in Rust, it should be like reasonably high performance Rust. We don't need to make optimize stuff by using raw pointers and unsafe.
We're not that high performance but avoiding cloning huge stuff is We're probably I wanna aim for a level of performance where we're doing like we're not doing wildly unnecessary clones of huge strings and stuff like that.
No unsafe if at all possible because the reliability is even more important than the performance. I want the server to just always work. 
Error handling, I want errors that we know about like we that we've uh build support for I guess. I want them to be displayed nicely. I want most errors in normal operations to be shown in a very nice way. Errors that are so far unexpected and we like are we handle in a fallback way should always be displayed in a way where I'm noticing that stuff is going on.

Um we should always if we ever display things in the UI where we have no idea how large the data is gonna be. Like we get random error messages and we just show the error message in a pop-up. We should always bound the data.

So if for some reason we get a huge stack trace, for example, we don't print a like three screens high pop-up or something. So we should bound the data we display in the GUI. Probably also add a little like hard coded error message, like error communicating with agent daemon or whatever, and then print the actual detail in the server log.

This is a developer tool, if stuff stuff goes wrong, it is expected that you might want to look at the logs to find out what's really going on. 

The server should keep keep as little data in memory as is necessary for smooth and of course like correct operations. But But we should keep an eye on evicting data that we don't no longer need. If switching between two sessions back and forth very quickly is much faster by keeping all of the session contents in memory instead of restreaming it from the daemon, then that's fine, but we should bound the level of sessions that are kept warm.

I think we're currently doing that. I just wanna nail that one down. 

Um we are currently not including the agent code in this code base we are shelling out to an existing poly token binary and since it is a very in-progress software we are this is currently used by me the author I am updating Polychokon whenever it updates whenever whenever new updateses com comes out out.

So we get newer versions of PolyToken all the time. So it is valuable to be forward compatible. If reasonably possible. But also um we need a workflow in place to update the API based on the self-describing um CLI um methods of the poly token binary Yeah.

Visuals: this needs to be expanded because I'm stopping now but in addition to supporting all of the features that PowerToken does we want to support extra niceties like searching across all sessions that we've discovered showing all sessions on the machine grouped by by project, archiving all sessions And mostly automatic Git or JJ workspace handling.
Wherever possible we want to mostly follow the lead of the Codex Desktop app because it looks really nice. We don't want to be a 100% copy, but it is fine to be a like 80 to 90% copy.

We want to display all the extra in-session notifications that the PolyToken Tui also does. I think the anything that the daemon SSE events expose are stuff that the Tui displays, so just showing everything that the daemon emits wherever, Like making a strong attempt to show everything that's being emitted and maybe like summarizing long events with uh Shorten title and then showing the full data on mouse over or when clicking on it on it in a pop-up is like that's that should be the main the default approach to showing unknown data or like data that we don't have like fully dedicated support for.

export interface CorrelatedResponse<T> {
  accepted: boolean;
  value: T;
}

/** Apply a reply only when it belongs to the newest request generation. */
export function applyCorrelatedResponse<T>(
  expected: number,
  current: T,
  received: number,
  response: T,
): CorrelatedResponse<T> {
  return received === expected
    ? { accepted: true, value: response }
    : { accepted: false, value: current };
}

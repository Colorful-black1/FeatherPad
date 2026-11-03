// Explicit application diagnostics only. Parser exceptions remain generic so
// their user code frames never reach logs or status messages.
export class FormatFailure extends Error {
  constructor(message: string, readonly offset = 0) { super(message); }
}

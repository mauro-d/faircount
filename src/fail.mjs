// Errors carry a `code` so callers can branch on it instead of matching message
// text. The helper drops itself from the stack trace. It lives here rather than
// in cvm.mjs so random.mjs, which cvm.mjs imports, can use it too.
export function fail (Type, code, message) {
  const error = new Type(message)
  error.code = code
  Error.captureStackTrace(error, fail)
  return error
}

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const errMsg = (e) => (e && e.message ? e.message : String(e));

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Wraps a route handler so thrown errors become JSON responses.
export function handle(fn) {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      return json({ error: errMsg(e) }, e && e.status ? e.status : 500);
    }
  };
}

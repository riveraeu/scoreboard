// Shared PT (Pacific Time) date utilities. Hoisted out of api/[...path].js so handler
// modules can reuse the same formatter without re-instantiating per request.

export const PT_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });

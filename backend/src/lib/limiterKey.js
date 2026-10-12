// Rate limits count per PERSON. A teammate's request runs as their company (req.user.id is the
// company's primary account), so keying on that would make a whole team share one hourly allowance.
export const userKey = req => req.user?.actorId || req.user?.id || req.ip

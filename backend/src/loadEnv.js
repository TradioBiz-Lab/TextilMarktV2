// Loads backend/.env, except under tests. Imported first by app.js so every later module sees the values.
//
// The test suite must never read this file: on a developer's machine it holds the Live connection string and
// secrets, and in the hosted sandbox's folder it switched the suite into another mode without anyone noticing
// (Foundation plan, finding 1). Tests set NODE_ENV=test before they import the app (tests/helpers/db.js) and
// supply everything they need themselves, exactly as they do in CI, where there is no .env at all.
import dotenv from 'dotenv'

if (process.env.NODE_ENV !== 'test') dotenv.config()

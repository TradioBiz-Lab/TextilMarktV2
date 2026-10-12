import { setStoredToken, setAuthToken } from './api.js'

/**
 * Swap the session (the server sets the cookie), then reload so every screen loads fresh as that
 * company. `call` is one of viewAsApi.start / viewAsApi.exit, already bound to its arguments.
 */
export async function switchTo(call) {
  const { user, token } = await call()
  setStoredToken(user.id)
  setAuthToken(token)
  window.location.reload()
}

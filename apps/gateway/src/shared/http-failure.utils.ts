/**
 * The error of a failed call to one of the HTTP APIs the gateway's services use (the metadata server, Secret Manager,
 * Compute Engine, GitHub): the action, the HTTP status and the start of the response body.
 */

/** How many characters of an API's error text an error message keeps. */
export const ERROR_TEXT_LIMIT = 300;

/** The error of a failed API call; the response body is cut short and holds no secret of the request. */
export async function failure(response: Response, action: string): Promise<Error> {
  const text = (await response.text()).replace(/\s+/g, " ").slice(0, ERROR_TEXT_LIMIT);
  return new Error(`failed to ${action}: HTTP ${response.status} ${text}`);
}

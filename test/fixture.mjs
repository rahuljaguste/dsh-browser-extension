/**
 * Fixture site for the end-to-end test. Served from loopback so the extension
 * exercises the same path a real http(s) page takes.
 */
import { createServer } from 'node:http'

const PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Companion Fixture</title></head>
  <body>
    <h1>Companion Fixture</h1>
    <label for="name">Name</label>
    <input id="name" placeholder="Your name" />
    <button id="greet">Greet</button>
    <div id="out"></div>
    <p><a id="next" href="/second">Second page</a></p>
    <form id="form" action="/submitted">
      <input name="q" id="q" placeholder="Search" />
      <button type="submit">Send</button>
    </form>
    <script>
      document.getElementById('greet').addEventListener('click', () => {
        document.getElementById('out').textContent =
          'Hello, ' + document.getElementById('name').value
      })
    </script>
  </body>
</html>`

const SECOND = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Second page</title></head>
  <body><h1>Second page</h1><p>Arrived.</p><a href="/">Back</a></body>
</html>`

/** Start the fixture server on an ephemeral port and return its URL. */
export async function startFixture() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/second') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(SECOND)
      return
    }
    if (url.pathname === '/submitted') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<html><body><h1>Submitted</h1><p>q=${url.searchParams.get('q') ?? ''}</p></body></html>`)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

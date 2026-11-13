import { Readable } from 'node:stream';

export async function requestRoute(handleRequest, url, data, method = 'POST', headers = {}) {
  const request = Readable.from(data === undefined ? [] : [JSON.stringify(data)]);
  request.url = url;
  request.method = data === undefined ? 'GET' : method;
  request.headers = { host: '127.0.0.1:3033', ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
  request.socket = { localPort: 3033 };
  const output = new Map();
  const chunks = [];
  const response = {
    headersSent: false,
    status: 200,
    setHeader(name, value) { output.set(name.toLowerCase(), value); },
    writeHead(status, values = {}) {
      this.status = status;
      this.headersSent = true;
      for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
    },
    end(chunk) {
      if (chunk != null) chunks.push(Buffer.from(chunk));
    },
  };
  await handleRequest(request, response);
  const bytes = Buffer.concat(chunks);
  return {
    status: response.status,
    headers: output,
    body: output.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes,
  };
}

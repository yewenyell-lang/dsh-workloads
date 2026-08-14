import http from 'node:http'
const port = Number(process.argv[2])
const server = http.createServer((req, res) => {
  res.statusCode = req.url === '/health' ? 200 : 404
  res.end(req.url === '/health' ? 'ok' : 'not found')
})
server.listen(port, '127.0.0.1', () => console.log(`READY ${port} password=smoke-only-value`))
const stop = () => server.close(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

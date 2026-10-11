// The official image's initialization server is socket-only. Wait for the final
// TCP listener before any setup SQL; never retry partially executed setup SQL.
function postgresReady(docker, name) {
  return docker('exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres').includes('accepting connections');
}
module.exports = { postgresReady };

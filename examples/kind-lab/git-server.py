# A minimal smart-HTTP Git server for a local lab: every request is handed to
# git http-backend, read-only, for the repositories under /srv/git.
import http.server, os, subprocess, urllib.parse

class Handler(http.server.BaseHTTPRequestHandler):
    def _run(self, method):
        url = urllib.parse.urlsplit(self.path)
        body = b""
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            body = self.rfile.read(length)
        env = {
            "PATH": os.environ["PATH"],
            "HOME": os.environ.get("HOME", "/root"),
            "GIT_PROJECT_ROOT": "/srv/git",
            "GIT_HTTP_EXPORT_ALL": "1",
            "REQUEST_METHOD": method,
            "PATH_INFO": url.path,
            "QUERY_STRING": url.query,
            "CONTENT_TYPE": self.headers.get("Content-Type", ""),
            "CONTENT_LENGTH": str(len(body)),
            "REMOTE_ADDR": self.client_address[0],
        }
        if self.headers.get("Git-Protocol"):
            env["HTTP_GIT_PROTOCOL"] = self.headers["Git-Protocol"]
        if self.headers.get("Content-Encoding"):
            env["HTTP_CONTENT_ENCODING"] = self.headers["Content-Encoding"]
        proc = subprocess.run(["git", "http-backend"], input=body, env=env, capture_output=True)
        if proc.stderr:
            self.log_message("http-backend: %s", proc.stderr.decode(errors="replace").strip())
        out = proc.stdout
        head, _, payload = out.partition(b"\r\n\r\n")
        if not _:
            head, _, payload = out.partition(b"\n\n")
        status = 200
        headers = []
        for line in head.decode("latin-1").splitlines():
            k, _, v = line.partition(":")
            if k.lower() == "status":
                status = int(v.strip().split()[0])
            elif k:
                headers.append((k.strip(), v.strip()))
        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self._run("GET")

    def do_POST(self):
        self._run("POST")

http.server.ThreadingHTTPServer(("", 80), Handler).serve_forever()

import os, http.server, socketserver, functools

DIRECTORY = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "1975")
PORT = 8531

os.chdir(DIRECTORY)
Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DIRECTORY)

class Server(socketserver.TCPServer):
    allow_reuse_address = True

with Server(("127.0.0.1", PORT), Handler) as httpd:
    print(f"serving {DIRECTORY} at http://127.0.0.1:{PORT}", flush=True)
    httpd.serve_forever()

/* Python runner: Pyodide (CPython compiled to WebAssembly) in a dedicated worker. */
const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/";
const ROOT = "/home/pyodide/ws";
let ready = null;

function load(post) {
  if (!ready) {
    post("sys", "Загружаю Python (первый запуск ~10 с)…\n");
    importScripts(PYODIDE_URL + "pyodide.js");
    ready = loadPyodide({ indexURL: PYODIDE_URL });
  }
  return ready;
}

function mkdirs(FS, path) {
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur += "/" + p;
    try {
      FS.mkdir(cur);
    } catch (e) {
      /* exists */
    }
  }
}

self.onmessage = async (e) => {
  const { id, files, entry, code, stdin } = e.data;
  const post = (type, text) => self.postMessage({ id, type, text });
  try {
    const py = await load(post);
    py.setStdout({ batched: (s) => post("out", s + "\n") });
    py.setStderr({ batched: (s) => post("err", s + "\n") });
    const lines = (stdin || "").split("\n");
    let i = 0;
    py.setStdin({ stdin: () => (i < lines.length ? lines[i++] : undefined) });

    mkdirs(py.FS, ROOT);
    for (const [path, content] of Object.entries(files || {})) {
      const full = ROOT + "/" + path;
      mkdirs(py.FS, full.slice(0, full.lastIndexOf("/")));
      py.FS.writeFile(full, content);
    }
    const source = code != null ? code : (files || {})[entry] || "";
    await py.loadPackagesFromImports(source);
    py.globals.set("__meraki_entry", entry || "");
    py.globals.set("__meraki_code", code != null ? code : null);
    await py.runPythonAsync(`
import os, sys, runpy
os.chdir(${JSON.stringify(ROOT)})
for _m in [k for k, v in list(sys.modules.items()) if getattr(v, "__file__", "") and str(v.__file__).startswith(${JSON.stringify(ROOT)})]:
    del sys.modules[_m]
if __meraki_code is not None:
    if ${JSON.stringify(ROOT)} not in sys.path: sys.path.insert(0, ${JSON.stringify(ROOT)})
    exec(compile(__meraki_code, "<tool>", "exec"), {"__name__": "__main__"})
else:
    _d = os.path.dirname(os.path.join(${JSON.stringify(ROOT)}, __meraki_entry))
    if _d not in sys.path: sys.path.insert(0, _d)
    runpy.run_path(os.path.join(${JSON.stringify(ROOT)}, __meraki_entry), run_name="__main__")
`);
  } catch (err) {
    post("err", String((err && err.message) || err) + "\n");
  }
  post("done", "");
};

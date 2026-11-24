import { Icon } from "../components/Icon";
import { useMemo, useState } from "react";
import { api } from "../api";
import { tracker } from "../telemetry/tracker";

type TreeNode = { name: string; path: string; dir: boolean; children: TreeNode[] };

function build(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", dir: true, children: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let cur = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      const dir = i < parts.length - 1;
      let child = cur.children.find((c) => c.name === part && c.dir === dir);
      if (!child) {
        child = { name: part, path, dir, children: [] };
        cur.children.push(child);
      }
      cur = child;
    });
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, "ru", { numeric: true }));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

const ICONS: Record<string, string> = { py: "code", js: "code", sql: "database", md: "note", txt: "file", json: "braces", html: "code", css: "palette", csv: "bars" };

export default function FileTree({ courseId, files, active, scope, createDir, onOpen, onChanged }: {
  courseId: number; files: string[]; active: string | null;
  /** Show only this folder (and below) as the tree root; paths are still absolute. */
  scope?: string;
  /** Relative folder under `scope` where root-level “+ Файл” / “+ Папка” create; defaults to scope root. */
  createDir?: string;
  onOpen: (p: string) => void; onChanged: () => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const scopePrefix = scope ? scope.replace(/\/+$/, "") : "";
  const scoped = useMemo(() => {
    const prefix = scopePrefix ? scopePrefix + "/" : "";
    return files
      .filter((f) => (prefix ? f.startsWith(prefix) : true))
      .map((f) => (prefix ? f.slice(prefix.length) : f));
  }, [files, scopePrefix]);
  // .keep stays in the tree data: build() needs it to render empty task folders (the file itself is hidden in render)
  const tree = useMemo(() => build(scoped), [scoped]);
  const activeRel = active && scopePrefix && active.startsWith(scopePrefix + "/") ? active.slice(scopePrefix.length + 1) : active;
  const full = (relative: string) => (scopePrefix ? `${scopePrefix}/${relative}` : relative);

  async function create(dir: string, folder: boolean) {
    const name = prompt(folder ? "Имя папки" : "Имя файла (например, main.py)");
    if (!name?.trim()) return;
    const base = dir || createDir || "";
    const relative = (base ? base + "/" : "") + name.trim().replace(/^\/+/, "");
    const path = full(relative);
    await api.put(`/courses/${courseId}/file`, { path: folder ? `${path}/.keep` : path, content: "" });
    tracker.log(folder ? "folder_create" : "file_create", path);
    await onChanged();
    if (!folder) onOpen(path);
  }

  async function rename(node: TreeNode) {
    const name = prompt("Новое имя", node.name);
    if (!name?.trim() || name === node.name) return;
    const parent = node.path.split("/").slice(0, -1).join("/");
    const target = full((parent ? parent + "/" : "") + name.trim());
    const old = full(node.path);
    await api.post(`/courses/${courseId}/rename`, { old, new: target });
    tracker.log("file_rename", old, { to: target });
    await onChanged();
  }

  async function remove(node: TreeNode) {
    if (!confirm(`Удалить ${node.dir ? "папку" : "файл"} «${node.name}»?`)) return;
    const path = full(node.path);
    await api.del(`/courses/${courseId}/file?path=${encodeURIComponent(path)}`);
    tracker.log("file_delete", path);
    await onChanged();
  }

  async function upload() {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = async () => {
      for (const f of Array.from(input.files ?? [])) {
        if (f.size > 1_000_000) {
          alert(`${f.name}: файл больше 1 МБ`);
          continue;
        }
        const content = await f.text();
        await api.put(`/courses/${courseId}/file`, { path: `uploads/${f.name}`, content });
        tracker.log("file_upload", `uploads/${f.name}`, { chars: content.length });
      }
      await onChanged();
    };
    input.click();
  }

  const render = (nodes: TreeNode[], depth: number) =>
    nodes
      .filter((n) => n.name !== ".keep")
      .map((n) => (
        <div key={n.path}>
          <div
            className={`tree-item ${activeRel === n.path ? "active" : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => (n.dir ? setCollapsed((c) => ({ ...c, [n.path]: !c[n.path] })) : onOpen(full(n.path)))}
          >
            <Icon name={n.dir ? (collapsed[n.path] ? "folder" : "folderOpen") : ICONS[n.name.split(".").pop() ?? ""] ?? "file"} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.name}</span>
            <span className="actions">
              {n.dir && <button className="icon-btn" title="Новый файл" onClick={(e) => { e.stopPropagation(); create(n.path, false); }}>＋</button>}
              <button className="icon-btn" title="Переименовать" onClick={(e) => { e.stopPropagation(); rename(n); }}>✎</button>
              <button className="icon-btn" title="Удалить" onClick={(e) => { e.stopPropagation(); remove(n); }}>✕</button>
            </span>
          </div>
          {n.dir && !collapsed[n.path] && render(n.children, depth + 1)}
        </div>
      ));

  return (
    <div className="tree" data-copy-source="workspace" title={scopePrefix || undefined}>
      <div className="row" style={{ gap: 4, marginBottom: 6 }}>
        <button className="btn sm" onClick={() => create("", false)}>+ Файл</button>
        <button className="btn sm" onClick={() => create("", true)}>+ Папка</button>
        <button className="btn sm ghost" onClick={upload} title="Загрузить текстовые файлы">⇪</button>
      </div>
      {tree.length ? render(tree, 0) : <div className="small muted">Пусто. Создай файл или папку.</div>}
    </div>
  );
}

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
    n.children.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

const ICONS: Record<string, string> = { py: "🐍", js: "📜", sql: "🗃️", md: "📝", txt: "📄", json: "🔧", html: "🌐", css: "🎨", csv: "📊" };

export default function FileTree({ courseId, files, active, onOpen, onChanged }: {
  courseId: number; files: string[]; active: string | null; onOpen: (p: string) => void; onChanged: () => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const visible = useMemo(() => files.filter((f) => !f.endsWith("/.keep") || true), [files]);
  const tree = useMemo(() => build(visible), [visible]);

  async function create(dir: string, folder: boolean) {
    const name = prompt(folder ? "Имя папки" : "Имя файла (например, main.py)");
    if (!name?.trim()) return;
    const path = (dir ? dir + "/" : "") + name.trim().replace(/^\/+/, "");
    await api.put(`/courses/${courseId}/file`, { path: folder ? `${path}/.keep` : path, content: "" });
    tracker.log(folder ? "folder_create" : "file_create", path);
    await onChanged();
    if (!folder) onOpen(path);
  }

  async function rename(node: TreeNode) {
    const name = prompt("Новое имя", node.name);
    if (!name?.trim() || name === node.name) return;
    const parent = node.path.split("/").slice(0, -1).join("/");
    const target = (parent ? parent + "/" : "") + name.trim();
    await api.post(`/courses/${courseId}/rename`, { old: node.path, new: target });
    tracker.log("file_rename", node.path, { to: target });
    await onChanged();
  }

  async function remove(node: TreeNode) {
    if (!confirm(`Удалить ${node.dir ? "папку" : "файл"} «${node.path}»?`)) return;
    await api.del(`/courses/${courseId}/file?path=${encodeURIComponent(node.path)}`);
    tracker.log("file_delete", node.path);
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
            className={`tree-item ${active === n.path ? "active" : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => (n.dir ? setCollapsed((c) => ({ ...c, [n.path]: !c[n.path] })) : onOpen(n.path))}
          >
            <span>{n.dir ? (collapsed[n.path] ? "📁" : "📂") : ICONS[n.name.split(".").pop() ?? ""] ?? "📄"}</span>
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
    <div className="tree" data-copy-source="workspace">
      <div className="row" style={{ gap: 4, marginBottom: 6 }}>
        <button className="btn sm" onClick={() => create("", false)}>+ Файл</button>
        <button className="btn sm" onClick={() => create("", true)}>+ Папка</button>
        <button className="btn sm ghost" onClick={upload} title="Загрузить текстовые файлы">⇪</button>
      </div>
      {tree.length ? render(tree, 0) : <div className="small muted">Пусто. Создай файл или папку.</div>}
    </div>
  );
}

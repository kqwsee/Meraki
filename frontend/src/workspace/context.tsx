import { createContext, useContext } from "react";

export type WsApi = {
  courseId: number;
  nodeId: number;
  stage: "practice" | "exam";
  files: string[];
  activePath: string | null;
  openFile: (path: string) => void;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  refreshFiles: () => Promise<void>;
  canvasSummary: () => string;
  showCanvas: () => void;
};

export const WsContext = createContext<WsApi | null>(null);
export const useWorkspace = () => useContext(WsContext);

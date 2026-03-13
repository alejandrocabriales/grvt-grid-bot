"use client";

import { LogEntry } from "@/lib/grid-bot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Terminal } from "lucide-react";

interface Props {
  logs: LogEntry[];
}

const LEVEL_STYLES: Record<LogEntry["level"], string> = {
  info: "text-zinc-400",
  warn: "text-amber-400",
  error: "text-red-400",
  success: "text-emerald-400",
};

const LEVEL_PREFIX: Record<LogEntry["level"], string> = {
  info: "[INFO]",
  warn: "[WARN]",
  error: "[ERR!]",
  success: "[ OK ]",
};

export function ActivityLog({ logs }: Props) {
  return (
    <Card className="bg-zinc-900 border-zinc-700 h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs text-zinc-400 flex items-center gap-2">
          <Terminal className="h-3.5 w-3.5" />
          Activity Log
          <span className="ml-auto text-zinc-600 font-normal">
            {logs.length} entries
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="h-80 overflow-y-auto font-mono text-xs space-y-0.5 pr-1">
          {logs.length === 0 && (
            <p className="text-zinc-600 text-center py-8">
              Bot idle. Start to see activity.
            </p>
          )}
          {logs.map((log, i) => (
            <div key={i} className="flex gap-2 leading-5">
              <span className="text-zinc-600 shrink-0">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              <span className={`shrink-0 ${LEVEL_STYLES[log.level]}`}>
                {LEVEL_PREFIX[log.level]}
              </span>
              <span className={LEVEL_STYLES[log.level]}>{log.message}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

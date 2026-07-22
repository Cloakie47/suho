import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EXPLORER } from "./config";
import { Seal } from "./ui";
import { humanError } from "./errors";

/// Toast system per the suho-design skill: ONE toast per transaction that
/// MUTATES through its lifecycle (pending -> preconfirmed -> final), never a
/// new toast per phase. Top-right stack (top-center on mobile), max 3 visible.
/// The seal-stamp micro-animation fires only on verification moments
/// (preconfirmed); errors speak in human sentences with the raw revert behind
/// a details disclosure.

type Phase = "pending" | "preconfirmed" | "final" | "error";

interface ToastItem {
  id: number;
  phase: Phase;
  label: string;
  ms?: number;
  txHash?: string;
  errorText?: string;
  raw?: string;
}

export interface TxToast {
  preconfirmed(label: string, ms: number): void;
  final(txHash: string): void;
  error(err: unknown): void;
  dismiss(): void;
}

interface ToastApi {
  begin(label: string): TxToast;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast outside ToastProvider");
  return api;
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, number>());

  const remove = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    const h = timers.current.get(id);
    if (h !== undefined) window.clearTimeout(h);
    timers.current.delete(id);
  }, []);

  const begin = useCallback(
    (label: string): TxToast => {
      const id = nextId++;
      setToasts((ts) => [...ts, { id, phase: "pending", label }]);
      return {
        preconfirmed: (doneLabel, ms) =>
          setToasts((ts) =>
            ts.map((t) => (t.id === id ? { ...t, phase: "preconfirmed", label: doneLabel, ms } : t)),
          ),
        final: (txHash) => {
          setToasts((ts) =>
            ts.map((t) =>
              t.id === id
                ? {
                    ...t,
                    phase: "final",
                    txHash,
                    // Flashblocks receipt can lose the race to inclusion; if
                    // preconf never landed, the label swaps straight to done.
                    label: t.phase === "pending" ? "Confirmed" : t.label,
                  }
                : t,
            ),
          );
          // Auto-dismiss 6s after final; pending/error never auto-dismiss.
          timers.current.set(id, window.setTimeout(() => remove(id), 6000));
        },
        error: (err) => {
          const { text, raw } = humanError(err);
          setToasts((ts) =>
            ts.map((t) => (t.id === id ? { ...t, phase: "error", errorText: text, raw } : t)),
          );
        },
        dismiss: () => remove(id),
      };
    },
    [remove],
  );

  // Dev-only hook so the lifecycle can be exercised (and screenshotted)
  // without a live transaction. Stripped from production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__suhoToastDemo = (kind: string = "ok") => {
      const t = begin("Sending 0.0002 ETH to suho.up.id…");
      if (kind === "error") {
        window.setTimeout(() => t.error(new Error("CodeInvalid")), 900);
        return;
      }
      window.setTimeout(() => t.preconfirmed("Sent", 872), 1400);
      window.setTimeout(
        () => t.final("0x5140fa4f8d3081b8f1accd82b1df4c157410cd055c888aead21463ff1263c8ec"),
        2600,
      );
    };
  }, [begin]);

  return (
    <ToastContext.Provider value={{ begin }}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.slice(-3).map((t) => (
          <div key={t.id} className={`toast toast-${t.phase}`}>
            <div className="toast-row">
              {t.phase === "pending" && <span className="spinner" />}
              {(t.phase === "preconfirmed" || t.phase === "final") && (
                <span className="toast-seal">
                  <Seal small />
                </span>
              )}
              <div className="toast-text">
                {t.phase === "error" ? (
                  <>
                    <div className="toast-label">{t.errorText}</div>
                    <details className="toast-details">
                      <summary>details</summary>
                      <div className="toast-raw">{t.raw}</div>
                    </details>
                  </>
                ) : (
                  <div className="toast-label">
                    {t.label}
                    {t.ms !== undefined && t.ms > 0 && (
                      <span className="toast-ms"> · {(t.ms / 1000).toFixed(1)}s</span>
                    )}
                  </div>
                )}
                {t.phase === "final" && t.txHash && (
                  <a
                    className="toast-link"
                    href={`${EXPLORER}/tx/${t.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Confirmed ↗
                  </a>
                )}
              </div>
              {(t.phase === "final" || t.phase === "error") && (
                <button className="toast-x" onClick={() => remove(t.id)} aria-label="Dismiss">
                  ×
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

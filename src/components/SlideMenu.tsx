import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clamp } from "../utils/math";

export type SlideMenuPage = "play" | "patch";

interface SlideMenuProps {
  currentPage: SlideMenuPage;
  onNavigate: (page: SlideMenuPage) => void;
}

const MENU_ITEMS: Array<{ label: string; page: SlideMenuPage }> = [
  { label: "Play", page: "play" },
  { label: "Patch", page: "patch" }
];

export function SlideMenu({ currentPage, onNavigate }: SlideMenuProps) {
  const handleRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const dragOffsetRef = useRef(0);
  const progressRef = useRef(0);
  const [handleOffset, setHandleOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  const resetHandle = useCallback(() => {
    setHandleOffset(0);
    setProgress(0);
    progressRef.current = 0;
    pointerIdRef.current = null;
    setDragging(false);
  }, []);

  const updateFromPointer = useCallback((clientY: number) => {
    const handle = handleRef.current;
    if (!handle) {
      return;
    }

    const handleHeight = handle.offsetHeight || 1;
    const maxTravel = Math.max(window.innerHeight - handleHeight, 1);
    const rawTop = clientY - dragOffsetRef.current;
    const constrainedTop = clamp(rawTop, 0, maxTravel);
    const nextProgress = constrainedTop / maxTravel;

    setHandleOffset(constrainedTop);
    setProgress(nextProgress);
    progressRef.current = nextProgress;
  }, []);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
  }, []);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = handleRef.current;
    if (!handle) {
      return;
    }

    pointerIdRef.current = event.pointerId;
    setDragging(true);
    handle.setPointerCapture?.(event.pointerId);

    const rect = handle.getBoundingClientRect();
    dragOffsetRef.current = event.clientY - rect.top;
    updateFromPointer(event.clientY);
  }, [updateFromPointer]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) {
      return;
    }

    updateFromPointer(event.clientY);
  }, [updateFromPointer]);

  const handlePointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) {
      return;
    }

    event.preventDefault();

    const handle = handleRef.current;
    handle?.releasePointerCapture?.(event.pointerId);

    if (progressRef.current >= 0.98) {
      setMenuOpen(true);
    }

    resetHandle();
  }, [resetHandle]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen, closeMenu]);

  useEffect(() => {
    if (menuOpen) {
      const previous = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = previous;
      };
    }
    return;
  }, [menuOpen]);

  useEffect(() => {
    const handleResize = () => {
      const handle = handleRef.current;
      if (!handle) {
        return;
      }
      const handleHeight = handle.offsetHeight || 1;
      const maxTravel = Math.max(window.innerHeight - handleHeight, 1);
      const constrainedTop = clamp(progressRef.current * maxTravel, 0, maxTravel);
      setHandleOffset(constrainedTop);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  const handleNavigate = useCallback((page: SlideMenuPage) => {
    onNavigate(page);
    setMenuOpen(false);
  }, [onNavigate]);

  const indicatorStyle = useMemo<React.CSSProperties>(() => ({
    height: `${Math.round(progress * 100)}%`
  }), [progress]);

  return (
    <>
      <div
        ref={handleRef}
        role="button"
        tabIndex={0}
        aria-label="Open navigation menu"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setMenuOpen(true);
            resetHandle();
          }
        }}
        style={{
          position: "fixed",
          top: "calc(env(safe-area-inset-top, 0px))",
          left: "50%",
          transform: `translate(-50%, ${handleOffset}px)`,
          transition: dragging || menuOpen ? "none" : "transform 0.3s ease",
          width: 88,
          height: 48,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(15, 23, 42, 0.85)",
          borderRadius: 9999,
          border: "1px solid rgba(148, 163, 184, 0.3)",
          color: "#e2e8f0",
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: 0.4,
          cursor: "grab",
          touchAction: "none",
          zIndex: 40,
          boxShadow: "0 8px 30px rgba(15, 23, 42, 0.45)",
          opacity: menuOpen ? 0 : 1,
          pointerEvents: menuOpen ? "none" : "auto",
          backdropFilter: "blur(12px)",
        }}
      >
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 6,
            borderRadius: 9999,
            background: "rgba(30, 41, 59, 0.65)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              background: "linear-gradient(180deg, #38bdf8 0%, #6366f1 100%)",
              ...indicatorStyle,
              transition: dragging ? "none" : "height 0.3s ease",
            }}
          />
        </div>
        <span style={{ position: "relative", zIndex: 1 }}>Menu</span>
      </div>

      {menuOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          onClick={closeMenu}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(2, 6, 23, 0.8)",
            backdropFilter: "blur(16px)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 24,
            padding: "calc(env(safe-area-inset-top, 0px) + 48px) 24px 24px",
            zIndex: 50,
            color: "#f8fafc",
            textAlign: "center",
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 16,
              width: "min(320px, 90vw)",
            }}
          >
            {MENU_ITEMS.map((item) => {
              const isActive = currentPage === item.page;
              return (
                <button
                  key={item.page}
                  type="button"
                  onClick={() => handleNavigate(item.page)}
                  style={{
                    padding: "18px 24px",
                    fontSize: 18,
                    fontWeight: 600,
                    borderRadius: 16,
                    border: "1px solid rgba(148, 163, 184, 0.25)",
                    background: isActive
                      ? "linear-gradient(135deg, rgba(34,211,238,0.2), rgba(167,139,250,0.2))"
                      : "rgba(15, 23, 42, 0.7)",
                    color: "#f1f5f9",
                    cursor: "pointer",
                    transition: "transform 0.2s ease, background 0.2s ease",
                    outline: "none",
                    boxShadow: isActive
                      ? "0 12px 24px rgba(99, 102, 241, 0.25)"
                      : "0 6px 16px rgba(15, 23, 42, 0.45)",
                  }}
                >
                  {item.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={closeMenu}
              style={{
                padding: "14px 18px",
                borderRadius: 12,
                border: "none",
                background: "rgba(15, 23, 42, 0.6)",
                color: "#cbd5f5",
                fontSize: 16,
                cursor: "pointer",
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}

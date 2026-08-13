/**
 * dsh-agent-workflow 活动面板（浏览器端）
 *
 * 手写 ModuleLoader 客户端（协议与 dsh-agent-teams/lib/client.js 一致）：
 * window.__ModuleLoader__.load({ id, factory: (require) => ... })，
 * 通过 require("react") / require("react-dom/client") 使用平台模块，
 * 导出 { inject, apply }。右上角浮层 1s 轮询
 * /plugins/dsh-agent-workflow/state，展示 tickets / reports / 审查结论 / 归档。
 */
window.__ModuleLoader__.load({
  id: "dsh-agent-workflow",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var createRoot = require("react-dom/client").createRoot;

    var STATE_URL = "/plugins/dsh-agent-workflow/state";
    var POLL_MS = 1000;
    var IDLE_COLLAPSE_MS = 2000;

    var S = {
      pill: {
        position: "fixed", top: "12px", right: "16px", zIndex: 9999,
        display: "flex", alignItems: "center", gap: "8px",
        padding: "8px 12px", borderRadius: "999px",
        background: "rgba(20,22,28,0.88)", color: "#e8e8ec",
        border: "1px solid rgba(255,255,255,0.12)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
        font: "12px/1.4 system-ui, sans-serif", cursor: "pointer",
        backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)"
      },
      card: {
        position: "fixed", top: "12px", right: "16px", zIndex: 9999,
        width: "320px", maxHeight: "72vh", overflow: "auto",
        borderRadius: "12px",
        background: "rgba(20,22,28,0.92)", color: "#e8e8ec",
        border: "1px solid rgba(255,255,255,0.12)",
        boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
        font: "12px/1.5 system-ui, sans-serif",
        backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)"
      },
      header: {
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.08)",
        fontWeight: 600
      },
      close: { background: "none", border: "none", color: "#9a9aa3", cursor: "pointer", fontSize: "14px" },
      body: { padding: "8px 12px 12px" },
      stats: { display: "flex", gap: "8px", margin: "8px 0 10px", flexWrap: "wrap" },
      stat: {
        flex: "1 1 auto", minWidth: "58px", textAlign: "center",
        padding: "6px 4px", borderRadius: "8px",
        background: "rgba(255,255,255,0.06)"
      },
      statNum: { display: "block", fontSize: "15px", fontWeight: 700 },
      statLabel: { display: "block", fontSize: "10px", color: "#9a9aa3" },
      wsTitle: { fontSize: "11px", color: "#9a9aa3", margin: "10px 0 4px", fontWeight: 600 },
      row: {
        display: "flex", alignItems: "center", gap: "6px",
        padding: "5px 6px", borderRadius: "6px",
        background: "rgba(255,255,255,0.04)", marginBottom: "4px"
      },
      rowName: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      badge: { fontSize: "10px", padding: "1px 6px", borderRadius: "999px", fontWeight: 600 },
      ok: { background: "rgba(46,160,67,0.22)", color: "#7ee787" },
      fail: { background: "rgba(248,81,73,0.22)", color: "#ffa198" },
      muted: { background: "rgba(139,148,158,0.18)", color: "#9a9aa3" },
      pulse: {
        width: "8px", height: "8px", borderRadius: "50%",
        background: "#7ee787", animation: "dsh-wf-pulse 1.2s ease-in-out infinite"
      },
      footer: { marginTop: "8px", fontSize: "10px", color: "#6e6e78", textAlign: "right" }
    };

    function fmtTime(ms) {
      if (!ms) return "";
      var d = new Date(ms);
      var p = function (n) { return String(n).padStart(2, "0"); };
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }

    function TicketRow(props) {
      var t = props.t;
      return React.createElement("div", { style: S.row },
        React.createElement("span", { style: S.rowName, title: t.name }, t.name),
        React.createElement("span", { style: Object.assign({}, S.badge, S.muted) }, t.tier),
        React.createElement("span", {
          style: Object.assign({}, S.badge, t.hasReport ? S.ok : S.fail),
          title: t.hasReport ? "有报告" : "缺报告"
        }, t.hasReport ? "✓" : "✗")
      );
    }

    function ReportRow(props) {
      var r = props.r;
      var badgeStyle = S.muted, label = "未审查";
      if (r.verdict === "PASS") { badgeStyle = S.ok; label = "PASS"; }
      else if (r.verdict === "FAIL") { badgeStyle = S.fail; label = "FAIL"; }
      else if (r.verdict === "INVALID") { badgeStyle = S.fail; label = "无效"; }
      return React.createElement("div", { style: S.row },
        React.createElement("span", { style: S.rowName, title: r.name }, r.name),
        React.createElement("span", { style: Object.assign({}, S.badge, badgeStyle) }, label),
        React.createElement("span", { style: { color: "#6e6e78", fontSize: "10px" } }, fmtTime(r.mtime))
      );
    }

    function Panel() {
      var state = React.useState(null);
      var snap = state[0], setSnap = state[1];
      var errState = React.useState(false);
      var error = errState[0], setError = errState[1];
      var openState = React.useState(true);
      var open = openState[0], setOpen = openState[1];

      React.useEffect(function () {
        var alive = true;
        var timer = null;
        var lastActivity = 0;
        var collapseTimer = null;
        function tick() {
          fetch(STATE_URL, { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (!alive) return;
              setSnap(d);
              setError(false);
              var total = 0;
              (d.workspaces || []).forEach(function (w) {
                total += (w.tickets || []).length + (w.reports || []).length;
              });
              if (total > 0) {
                lastActivity = Date.now();
                setOpen(true);
                if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
              } else if (lastActivity > 0 && Date.now() - lastActivity > IDLE_COLLAPSE_MS) {
                setOpen(false);
              }
            })
            .catch(function () { if (alive) setError(true); })
            .finally(function () { if (alive) timer = setTimeout(tick, POLL_MS); });
        }
        tick();
        return function () {
          alive = false;
          if (timer) clearTimeout(timer);
          if (collapseTimer) clearTimeout(collapseTimer);
        };
      }, []);

      var workspaces = snap ? (snap.workspaces || []) : [];
      var ticketCount = 0, reportCount = 0, pass = 0, fail = 0;
      workspaces.forEach(function (w) {
        ticketCount += (w.tickets || []).length;
        (w.reports || []).forEach(function (r) {
          reportCount += 1;
          if (r.verdict === "PASS") pass += 1;
          else if (r.verdict === "FAIL") fail += 1;
        });
      });

      var styleTag = document.createElement("style");
      if (!document.getElementById("dsh-wf-keyframes")) {
        styleTag.id = "dsh-wf-keyframes";
        styleTag.textContent = "@keyframes dsh-wf-pulse { 0%,100% { opacity:1; } 50% { opacity:0.35; } }";
        document.head.appendChild(styleTag);
      }

      if (error) {
        return React.createElement("div", { style: S.pill }, "⚠ 工作流面板离线");
      }
      if (!open || (ticketCount + reportCount === 0 && !snap)) {
        return React.createElement("div", {
          style: S.pill,
          onClick: function () { setOpen(true); },
          title: "展开工作流活动面板"
        },
          React.createElement("span", { style: S.pulse }),
          "工作流 " + ticketCount + "票 / " + reportCount + "报"
        );
      }

      return React.createElement("div", { style: S.card },
        React.createElement("div", { style: S.header },
          React.createElement("span", null, "工作流状态"),
          React.createElement("button", { style: S.close, onClick: function () { setOpen(false); }, title: "收起" }, "—")
        ),
        React.createElement("div", { style: S.body },
          React.createElement("div", { style: S.stats },
            React.createElement("div", { style: S.stat },
              React.createElement("span", { style: S.statNum }, ticketCount),
              React.createElement("span", { style: S.statLabel }, "tickets")
            ),
            React.createElement("div", { style: S.stat },
              React.createElement("span", { style: S.statNum }, reportCount),
              React.createElement("span", { style: S.statLabel }, "reports")
            ),
            React.createElement("div", { style: S.stat },
              React.createElement("span", { style: Object.assign({}, S.statNum, { color: "#7ee787" }) }, pass),
              React.createElement("span", { style: S.statLabel }, "PASS")
            ),
            React.createElement("div", { style: S.stat },
              React.createElement("span", { style: Object.assign({}, S.statNum, { color: "#ffa198" }) }, fail),
              React.createElement("span", { style: S.statLabel }, "FAIL")
            )
          ),
          workspaces.map(function (w) {
            return React.createElement("div", { key: w.path },
              React.createElement("div", { style: S.wsTitle }, w.title),
              (w.tickets || []).length > 0
                ? (w.tickets || []).map(function (t) {
                    return React.createElement(TicketRow, { key: t.name, t: t });
                  })
                : React.createElement("div", { style: Object.assign({}, S.row, { color: "#6e6e78" }) }, "无 tickets"),
              (w.reports || []).length > 0
                ? (w.reports || []).map(function (r) {
                    return React.createElement(ReportRow, { key: r.name, r: r });
                  })
                : React.createElement("div", { style: Object.assign({}, S.row, { color: "#6e6e78" }) }, "无 reports"),
              (w.archives || []).length > 0
                ? React.createElement("div", { style: S.wsTitle }, "归档: " + (w.archives || []).join(" · "))
                : null
            );
          }),
          React.createElement("div", { style: S.footer },
            snap && snap.updatedAt ? "更新于 " + fmtTime(snap.updatedAt) : "等待数据…"
          )
        )
      );
    }

    function apply(ctx) {
      var host = document.createElement("div");
      host.dataset.agentWorkflowHost = "";
      document.body.appendChild(host);
      var root = createRoot(host);
      root.render(React.createElement(Panel));
      ctx.effect(function () {
        return function () {
          root.unmount();
          host.remove();
        };
      }, "agent-workflow: activity panel");
    }

    exports.inject = ["slots", "sessions"];
    exports.apply = apply;
    return module.exports;
  }
});

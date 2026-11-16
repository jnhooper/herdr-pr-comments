// The open comments on the pull request for the shown space's branch.
//
// The space's folder is where its focused terminal is (a worktrunk worktree is
// just another checkout), its branch is that checkout's, and `gh pr view` finds
// the PR for that branch. Unresolved review threads come first; the PR's
// conversation (top-level comments and review summaries) folds below.
//
// Runs `git` and `gh` (on the space's machine). Nothing else leaves the machine.
// "Send to agent" pastes a thread (or all unresolved ones) into the space's agent
// with `hc send`, or starts Claude in a new tab with it when the space has none.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { spaces, panes, focused, exec, theme, agents, hc, run, openOverlay, closeOverlay, props, notify } from "herdr";
import { critters, pixel } from "./critters-look.js";

const REFRESH = 90000; // a full look this often while Herdr is open
const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) { nodes { id isResolved isOutdated path line originalLine
        comments(first: 30) { totalCount nodes { author { login } body createdAt url } } } }
      comments(last: 50) { nodes { author { login } body createdAt url } }
      reviews(last: 50) { nodes { author { login } state body submittedAt url } }
    }
  }
}`;

// Where the shown space is now: its focused pane's folder, as the Changes panel does.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const keyOf = (loc) => JSON.stringify([loc.on ?? null, loc.cwd ?? null]);

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const STATE = { OPEN: "working", MERGED: "done", CLOSED: "blocked" };

// One review thread as text an agent can act on.
function threadText(th) {
  const line = th.line ?? th.originalLine;
  const head = `### ${th.path}${line ? `:${line}` : ""}${th.isOutdated ? " (outdated: the code has moved since)" : ""}`;
  const said = th.comments.nodes.map((c) => `@${c.author?.login ?? "ghost"}:\n${(c.body ?? "").trim()}`).join("\n\n");
  return `${head}\n${th.comments.nodes[0]?.url ?? ""}\n\n${said}`;
}

function prompt(pr, threads) {
  const head = threads.length === 1
    ? `Please address this review comment on PR #${pr.number} "${pr.title}" (${pr.url}).`
    : `Please address these ${threads.length} unresolved review comments on PR #${pr.number} "${pr.title}" (${pr.url}).`;
  const tail = "Fix what's right in this checkout and tell me where you disagree. Don't reply on or resolve the threads on GitHub.";
  return [head, ...threads.map(threadText), tail].join("\n\n");
}

const agentLabel = (a) => `${a.program?.name ?? a.app ?? "Agent"} · tab ${a.tab_name}`;

async function sendTo(address, text) {
  const r = await hc(["send", address, text]);
  if (r.code === 0) return null;
  return (r.stderr || r.stdout || "hc send failed").trim().split("\n")[0];
}

export default class PrComments extends View {
  init(_props, cx) {
    if (props()?.pick) return; // the agent picker popup: no looking up of its own
    this.cache = {}; // key -> { kind, branch, pr, threads, conversation, at }
    this.loading = new Set();
    this.showConversation = false;
    this.showResolved = false;
    this.sent = {}; // send key -> { state: "sending" | "sent" | "error", to?, message? }
    cx.timer.every(1500, (cx) => {
      // Cheap: only a new folder (another space, a cd, a worktree) asks again.
      const k = keyOf(location());
      if (k !== this.key) { this.key = k; this.refresh(cx); cx.notify(); }
    });
    cx.timer.every(REFRESH, (cx) => this.refresh(cx));
    this.key = keyOf(location());
    this.refresh(cx);
  }

  refresh(cx) {
    const loc = location(), k = keyOf(loc);
    if (!loc.cwd || this.loading.has(k)) return;
    this.loading.add(k);
    cx.spawn(async (cx) => {
      try { this.cache[k] = await this.look(loc); }
      catch (e) { this.cache[k] = { kind: "error", message: String(e?.message ?? e) }; }
      this.loading.delete(k);
      cx.notify();
    });
  }

  async look({ cwd, on }) {
    const opts = { cwd, on, timeout: 30000 };
    const head = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts);
    if (head.code !== 0) return { kind: "norepo" };
    const branch = head.stdout.trim();
    const view = await exec("gh", ["pr", "view", "--json", "number,title,url,state,isDraft,reviewDecision,baseRefName"], opts);
    if (view.code !== 0) {
      const why = `${view.stderr}${view.stdout}`;
      if (/no (open )?pull requests? found/i.test(why)) return { kind: "nopr", branch };
      if (/gh auth login|not logged in|authentication/i.test(why)) return { kind: "error", message: "gh isn't signed in. Run `gh auth login`." };
      return { kind: "error", message: why.trim().split("\n")[0] || "gh pr view failed" };
    }
    const pr = JSON.parse(view.stdout);
    const [, owner, name] = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(pr.url) ?? [];
    const q = await exec("gh", ["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${pr.number}`, "-f", `query=${QUERY}`], opts);
    if (q.code !== 0) return { kind: "error", message: (q.stderr || q.stdout).trim().split("\n")[0] };
    const data = JSON.parse(q.stdout).data?.repository?.pullRequest;
    const threads = (data?.reviewThreads?.nodes ?? []).filter((t) => t.comments.nodes.length);
    const conversation = [
      ...(data?.comments?.nodes ?? []).map((c) => ({ ...c, kind: "comment" })),
      ...(data?.reviews?.nodes ?? []).filter((r) => r.body?.trim()).map((r) => ({ ...r, createdAt: r.submittedAt, kind: "review" })),
    ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return { kind: "pr", branch, pr, threads, conversation, at: Date.now() };
  }

  // To the space's agent: the focused one, else its only one; several: a picker;
  // none: Claude in a new tab of this space, with the comments as its first message.
  deliver(key, text, pr, cx) {
    const space = spaces().find((s) => s.active);
    const list = agents().filter((a) => a.space === space?.id);
    const pick = list.find((a) => a.focused) ?? (list.length === 1 ? list[0] : null);
    if (pick) {
      this.sent[key] = { state: "sending", to: agentLabel(pick) };
      cx.notify();
      cx.spawn(async (cx) => {
        const error = await sendTo(pick.address, text);
        this.sent[key] = error ? { state: "error", message: error } : { state: "sent", to: agentLabel(pick) };
        if (error) notify({ title: "Couldn't send to the agent", body: error, level: "error" });
        cx.notify();
      });
    } else if (list.length > 1) {
      openOverlay({ mod: "pr-comments", kind: "popup", frame: "none", width: 260, height: list.length * 30 + 38,
        props: { pick: { text, addresses: list.map((a) => a.address) } } });
    } else {
      run("tab.new", { space: space?.id, folder: location().cwd, name: `PR #${pr.number}`, argv: ["claude"], task: text });
      this.sent[key] = { state: "sent", to: "new Claude tab" };
      cx.notify();
    }
  }

  // The agent picker popup (this mod, with props().pick).
  picker() {
    const t = theme(), L = critters();
    const { text, addresses } = props().pick;
    const close = () => closeOverlay(props().overlay);
    const list = agents().filter((a) => addresses.includes(a.address));
    return v_flex().size_full().p(4).bg(L ? L.colors.bg : t.popover).border(L ? 2 : 1).border_color(t.border).rounded(L ? 0 : 8)
      .child(div().px(8).h(24).flex().items_center().child(this.label(L, t, "Send to")))
      .children(list.map((a) => h_flex().id(`pick-${a.address}`).h(30).px(8).gap(8).items_center().rounded(L ? 0 : 5).cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .on_click((_e, cx) => {
          close();
          cx.spawn(async () => {
            const error = await sendTo(a.address, text);
            notify(error ? { title: "Couldn't send to the agent", body: error, level: "error" } : { title: `Sent to ${agentLabel(a)}`, timeout: 3000 });
          });
        })
        .child(div().size(7).rounded(4).flex_none().bg(t[a.status] ?? t.idle))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(agentLabel(a)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(a.status))));
  }

  // "Send to agent", and what happened to the last send from this button.
  sendButton(key, t, L, text, pr, label = "Send to agent") {
    const s = this.sent[key];
    const shown = s?.state === "sending" ? "Sending…" : s?.state === "sent" ? `Sent to ${s.to}` : s?.state === "error" ? "Failed, retry" : label;
    const color = s?.state === "sent" ? t.done : s?.state === "error" ? t.blocked : t.muted;
    return h_flex().id(`send-${key}`).flex_none().h(22).px(7).gap(5).items_center().rounded(L ? 0 : 5).border(1).border_color(t.border)
      .text_color(color).cursor_pointer().hover((el) => el.bg(t.hover).text_color(t.foreground))
      .tooltip(s?.state === "error" ? s.message : "Paste into this space's agent and submit")
      .on_click((_e, cx) => { cx.stop_propagation(); this.deliver(key, text, pr, cx); })
      .child(svg("mods/pr-comments/send.svg").size(11))
      .child(L ? pixel(L, div(), 8, color).child(shown.toUpperCase()) : div().text_size(11).child(shown));
  }

  open(url) {
    if (url) exec("open", [url]).catch(() => {});
  }

  // Look helpers: the critters look when published, plain theme text otherwise.
  label(L, t, text, color) {
    return L ? pixel(L, div(), 9, color ?? L.colors.head).child(text.toUpperCase())
      : div().text_size(11).font_semibold().text_color(color ?? t.dim).child(text);
  }

  iconButton(id, t, icon, tooltip, action, spin) {
    const glyph = svg(icon).size(13);
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tooltip)
      .on_click(action).child(spin ? glyph.spin(900) : glyph);
  }

  comment(id, c, t, L, { first }) {
    return v_flex().gap(4)
      .when(!first, (el) => el.pt(8).border_t(1).border_color(t.border))
      .child(h_flex().gap(6).items_center().text_size(11.5)
        .child(div().font_semibold().text_color(L ? L.colors.text : t.foreground).child(c.author?.login ?? "ghost"))
        .child(div().text_color(t.dim).child(ago(c.createdAt))))
      .child(div().text_size(12.5).text_color(t.foreground).child(TextView.markdown(id, c.body || "_(no text)_").selectable(true)));
  }

  thread(th, t, L, pr) {
    const line = th.line ?? th.originalLine;
    const parts = th.path.split("/");
    const where = `${parts.length > 2 ? "…/" : ""}${parts.slice(-2).join("/")}${line ? `:${line}` : ""}`;
    const [first, ...rest] = th.comments.nodes;
    const more = th.comments.totalCount - th.comments.nodes.length;
    return v_flex().id(`thread-${th.id}`).flex_none().gap(8).p(10).rounded(L ? 0 : 8)
      .bg(t.surface).border(L ? 2 : 1).border_color(th.isResolved ? t.border : (L ? L.scenes[L.localScene].edge : t.border))
      .when(th.isResolved, (el) => el.opacity(0.6))
      .child(h_flex().gap(6).items_center()
        .child(div().id(`path-${th.id}`).flex_1().min_w(0).truncate().text_size(11.5).font_family("JetBrains Mono").text_color(t.muted).tooltip(`${th.path}${line ? `:${line}` : ""}`).child(where))
        .when(th.isOutdated, (el) => el.child(this.label(L, t, "outdated", t.dim)))
        .when(th.isResolved, (el) => el.child(this.label(L, t, "resolved", t.done)))
        .child(this.iconButton(`open-${th.id}`, t, "mods/pr-comments/external.svg", "Open on GitHub", () => this.open(first.url))))
      .child(this.comment(`c-${th.id}-0`, first, t, L, { first: true }))
      .children(rest.map((c, i) => this.comment(`c-${th.id}-${i + 1}`, c, t, L, { first: false })))
      .when(more > 0, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(`+${more} more on GitHub`)))
      .when(!th.isResolved, (el) => el.child(h_flex().justify_end().child(this.sendButton(`thread-${th.id}`, t, L, prompt(pr, [th]), pr))));
  }

  section(id, t, L, title, count, open, toggle) {
    return h_flex().id(id).flex_none().h(28).gap(6).items_center().cursor_pointer().on_click(toggle)
      .child(div().text_color(t.dim).child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11)))
      .child(this.label(L, t, title))
      .child(this.label(L, t, String(count), t.muted));
  }

  message(t, L, title, body) {
    return v_flex().flex_1().gap(6).p(16).items_start()
      .child(L ? pixel(L, div(), 11, L.colors.machine).child(title.toUpperCase()) : div().text_size(13).font_semibold().text_color(t.foreground).child(title))
      .when(Boolean(body), (el) => el.child(div().text_size(12).text_color(t.dim).child(body)));
  }

  render() {
    if (props()?.pick) return this.picker();
    const t = theme(), L = critters();
    const loc = location(), k = keyOf(loc);
    const state = this.cache[k];
    const loading = this.loading.has(k);
    const pr = state?.kind === "pr" ? state.pr : null;

    const header = h_flex().flex_none().h(44).px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(svg("mods/pr-comments/pr.svg").size(14).flex_none().text_color(pr ? t[STATE[pr.state] ?? "idle"] : t.dim))
      .child(L ? pixel(L, div(), 11, L.colors.text).flex_none().child(pr ? `PR #${pr.number}` : "PULL REQUEST")
        : div().flex_none().text_size(14).font_semibold().text_color(t.foreground).child(pr ? `PR #${pr.number}` : "Pull request"))
      .when(Boolean(pr), (el) => el.child(div().flex_none().px(5).h(17).flex().items_center().rounded(L ? 0 : 4).border(1)
        .border_color(t[STATE[pr.state] ?? "idle"]).text_color(t[STATE[pr.state] ?? "idle"]).text_size(10)
        .when(Boolean(L), (b) => b.font_family(L.fonts.pixel))
        .child(pr.isDraft ? "DRAFT" : pr.state)))
      .child(div().flex_1())
      .when(Boolean(pr), (el) => el.child(this.iconButton("pr-open", t, "mods/pr-comments/external.svg", "Open the PR on GitHub", () => this.open(pr.url))))
      .child(this.iconButton("pr-refresh", t, loading ? "mods/workspace-chrome/spinner.svg" : "mods/pr-comments/refresh.svg", "Look again", (_e, cx) => { this.refresh(cx); cx.notify(); }, loading));

    let body;
    if (!loc.cwd) body = this.message(t, L, "No folder", "Open a terminal in this space.");
    else if (!state) body = this.message(t, L, "Looking…", null);
    else if (state.kind === "norepo") body = this.message(t, L, "Not a git repository", null);
    else if (state.kind === "nopr") body = this.message(t, L, "No pull request", `Nothing open for ${state.branch}. Push it and open one with \`gh pr create\`.`);
    else if (state.kind === "error") body = this.message(t, L, "Couldn't ask GitHub", state.message);
    else {
      const open = state.threads.filter((th) => !th.isResolved);
      const resolved = state.threads.filter((th) => th.isResolved);
      body = v_flex().id("pr-list").flex_1().min_h(0).px(12).pb(14).gap(8).overflow_y_scrollbar()
        .child(div().flex_none().pt(10).text_size(12.5).text_color(t.foreground).child(pr.title))
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child(`${state.branch} → ${pr.baseRefName}`))
        .child(h_flex().flex_none().items_center()
          .child(div().flex_1().child(this.section("sec-open", t, L, "Unresolved", open.length, true, () => {})))
          .when(open.length > 1, (el) => el.child(this.sendButton(`all-${pr.number}`, t, L, prompt(pr, open), pr, "Send all"))))
        .when(open.length === 0, (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child("No open review threads.")))
        .children(open.map((th) => this.thread(th, t, L, pr)))
        .child(this.section("sec-conv", t, L, "Conversation", state.conversation.length, this.showConversation, (_e, cx) => { this.showConversation = !this.showConversation; cx.notify(); }))
        .when(this.showConversation, (el) => el.children(state.conversation.map((c, i) =>
          v_flex().id(`conv-${i}`).flex_none().gap(6).p(10).rounded(L ? 0 : 8).bg(t.surface).border(1).border_color(t.border)
            .when(c.kind === "review", (v) => v.child(this.label(L, t, `review · ${c.state.toLowerCase().replace(/_/g, " ")}`, c.state === "CHANGES_REQUESTED" ? t.blocked : c.state === "APPROVED" ? t.done : t.dim)))
            .child(this.comment(`conv-c-${i}`, c, t, L, { first: true })))))
        .when(resolved.length > 0, (el) => el
          .child(this.section("sec-resolved", t, L, "Resolved", resolved.length, this.showResolved, (_e, cx) => { this.showResolved = !this.showResolved; cx.notify(); }))
          .when(this.showResolved, (r) => r.children(resolved.map((th) => this.thread(th, t, L, pr)))));
    }

    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13).child(header).child(body);
  }
}

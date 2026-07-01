import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  type Edge as RFEdge,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';

import type { Edge, EdgeKind, Graph, ServiceNode } from '../../analyzer/types';
import type { FilterState } from './Filters';
import { layoutDagre } from './layout-dagre';
import { EDGE_STYLE, SCOPE_STYLE } from './style';

/** Fixed node width so port rows have a stable horizontal box. */
const NODE_WIDTH = 300;
/** Height of the header block (impl / token / domain lines + padding). */
const HEADER_HEIGHT = 68;
/** Per-port row height. Must stay in sync with the CSS below. */
const PORT_ROW_HEIGHT = 18;
/** Vertical padding between the header divider and the first port row. */
const PORTS_PAD_TOP = 4;

/**
 * Per-node method port lists. `outPorts` are methods on this service that
 * make calls into a dependency (they anchor the source end of edges leaving
 * this node); `inPorts` are methods on this service that other services
 * call into (they anchor the target end of edges entering this node).
 */
interface ServicePortsInfo {
  inPorts: string[];
  outPorts: string[];
  /**
   * Subset of `inPorts` that actually has at least one edge terminating on
   * it (as opposed to being seeded from the interface's declared surface
   * with no caller). Used to dim the handle / label so unused public
   * methods stand out visually.
   */
  connectedIn: Set<string>;
}

interface GraphViewProps {
  graph: Graph;
  filters: FilterState;
  /** Selected `ServiceNode.id`. */
  selectedId?: string;
  onSelect: (id?: string) => void;
}

interface ServiceNodeData extends Record<string, unknown> {
  service: ServiceNode;
  selected: boolean;
  /**
   * True when the search box has content and this node matches. Rendered
   * as a distinct cyan outline so search hits are visually separable from
   * the yellow-outlined click-selected node.
   */
  matched: boolean;
  dim: boolean;
  ports: ServicePortsInfo;
}

const EVENT_KINDS: Set<EdgeKind> = new Set(['publish', 'subscribe', 'emit', 'on']);

/**
 * The method name that an edge terminates at on the target node. For plain
 * calls this is `ref.toMethod`; for event-bus edges, where the call is
 * `bus.publish(...)` etc., the method name is already carried by the edge
 * kind so we surface it as the effective toMethod so the target node grows
 * a matching port row.
 */
function effectiveToMethod(kind: EdgeKind, refTo: string | undefined): string | undefined {
  if (refTo !== undefined) return refTo;
  if (EVENT_KINDS.has(kind)) return kind;
  return undefined;
}

/**
 * Build the port lists per node from a set of edges.
 *
 * `inPorts` are seeded from `service.publicMembers` — every method /
 * property declared on the service's interface, whether anything actually
 * calls it or not, so the node advertises its full public surface. Any
 * inbound edge method that isn't already in that seed (unusual — usually
 * event-bus edges named after the kind) is folded in too.
 *
 * `outPorts` remain edge-driven: they are the methods on THIS service
 * that make a call outward, so filtering out an edge kind naturally
 * collapses the rows it would have populated.
 */
function computeServicePorts(
  services: ServiceNode[],
  edges: Edge[],
): Map<string, ServicePortsInfo> {
  const acc = new Map<
    string,
    { in: Set<string>; out: Set<string>; connectedIn: Set<string> }
  >();
  for (const s of services) {
    const bucket = {
      in: new Set<string>(),
      out: new Set<string>(),
      connectedIn: new Set<string>(),
    };
    if (s.publicMembers) {
      for (const name of s.publicMembers) bucket.in.add(name);
    }
    acc.set(s.id, bucket);
  }
  for (const e of edges) {
    const src = acc.get(e.from);
    const dst = acc.get(e.to);
    for (const ref of e.refs) {
      const toMethod = effectiveToMethod(e.kind, ref.toMethod);
      if (ref.fromMethod !== undefined && src) src.out.add(ref.fromMethod);
      if (toMethod !== undefined && dst) {
        dst.in.add(toMethod);
        dst.connectedIn.add(toMethod);
      }
    }
  }
  const result = new Map<string, ServicePortsInfo>();
  for (const [id, sets] of acc) {
    result.set(id, {
      inPorts: [...sets.in].sort(),
      outPorts: [...sets.out].sort(),
      connectedIn: sets.connectedIn,
    });
  }
  return result;
}

function nodeHeight(ports: ServicePortsInfo): number {
  const rows = Math.max(ports.inPorts.length, ports.outPorts.length);
  if (rows === 0) return HEADER_HEIGHT;
  return HEADER_HEIGHT + PORTS_PAD_TOP + rows * PORT_ROW_HEIGHT + PORTS_PAD_TOP;
}

function ServiceNodeView({ data }: NodeProps<Node<ServiceNodeData>>): JSX.Element {
  const { service, selected, matched, dim, ports } = data;
  const bg = SCOPE_STYLE[service.scope].color;
  const rowCount = Math.max(ports.inPorts.length, ports.outPorts.length);
  // Interface-only node: the token is referenced but has no registered impl.
  // Flagged with a dashed warning border so missing bindings stand out from
  // concrete services at a glance. Selection / search-match still win so the
  // active node stays unambiguous.
  const isUnresolved = service.unresolved === true;
  const borderColor = selected
    ? '#ffdf5d'
    : matched
      ? '#79c0ff'
      : isUnresolved
        ? '#f85149'
        : 'rgba(0,0,0,0.4)';
  const borderWidth = selected || matched || isUnresolved ? 2 : 1;
  const borderStyle = isUnresolved && !selected && !matched ? 'dashed' : 'solid';
  const glow = selected
    ? '0 0 0 3px rgba(255,223,93,0.25)'
    : matched
      ? '0 0 0 3px rgba(121,192,255,0.25)'
      : 'none';
  return (
    <div
      style={{
        background: bg,
        color: 'white',
        borderRadius: 6,
        border: `${borderWidth}px ${borderStyle} ${borderColor}`,
        boxShadow: glow,
        fontSize: 12,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        opacity: dim ? 0.18 : 1,
        width: NODE_WIDTH,
        position: 'relative',
      }}
    >
      {/* Fallback handles at the header — for refs with no method attribution
          (raw ctor param declarations, un-chained `.get(IX)` lookups). */}
      <Handle
        id="default-target"
        type="target"
        position={Position.Right}
        style={{ background: '#555', top: HEADER_HEIGHT / 2 }}
      />
      <Handle
        id="default-source"
        type="source"
        position={Position.Left}
        style={{ background: '#555', top: HEADER_HEIGHT / 2 }}
      />

      {/* Header */}
      <div style={{ padding: '6px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span
            style={{
              fontSize: 9,
              padding: '1px 5px',
              background: 'rgba(0,0,0,0.35)',
              borderRadius: 3,
            }}
          >
            {SCOPE_STYLE[service.scope].badge}
          </span>
          {/* Impl is the primary label — that's the actual class the container
              constructs; the token is a secondary identity shown below. */}
          <span
            style={{
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {service.impl}
          </span>
        </div>
        <div style={{ fontSize: 10, opacity: 0.65, marginTop: 2, fontStyle: 'italic' }}>
          {isUnresolved ? 'no implementation registered' : service.token}
        </div>
        <div style={{ fontSize: 10, opacity: 0.75, marginTop: 2 }}>{service.domain}</div>
      </div>

      {rowCount > 0 && (
        <div
          style={{
            borderTop: '1px solid rgba(0,0,0,0.25)',
            background: 'rgba(0,0,0,0.15)',
            padding: `${PORTS_PAD_TOP}px 0`,
          }}
        >
          {Array.from({ length: rowCount }, (_, i) => {
            const out = ports.outPorts[i];
            const inn = ports.inPorts[i];
            return (
              <div
                key={i}
                style={{
                  // `position: relative` anchors the row's Handles to the
                  // row itself; React Flow measures the dot's centre from
                  // this box, so alignment tracks the label automatically
                  // — no hardcoded pixel offsets to drift out of sync.
                  position: 'relative',
                  height: PORT_ROW_HEIGHT,
                }}
              >
                {/* Handles live directly on the row (no `overflow: hidden`
                    ancestor), so React Flow's default translate(-50%, -50%)
                    positions the dot straddling the node's border. */}
                {out !== undefined && (
                  <Handle
                    id={`out:${out}`}
                    type="source"
                    position={Position.Left}
                    style={{ background: '#f6c896' }}
                  />
                )}
                {inn !== undefined && (
                  <Handle
                    id={`in:${inn}`}
                    type="target"
                    position={Position.Right}
                    // Dim handle when the port is only there because it's
                    // declared on the interface — nothing calls into it.
                    // The connected-vs-declared distinction reads at a
                    // glance without hunting for edges.
                    style={{
                      background: ports.connectedIn.has(inn) ? '#a8c8f6' : '#3d444d',
                    }}
                  />
                )}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    height: '100%',
                    padding: '0 10px',
                    fontSize: 10,
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      textAlign: 'left',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: '#fbe4c8',
                    }}
                  >
                    {out ?? ''}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      textAlign: 'right',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color:
                        inn !== undefined && !ports.connectedIn.has(inn)
                          ? '#6e7681'
                          : '#c8e0fb',
                    }}
                  >
                    {inn ?? ''}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BandLabelView({ data }: NodeProps<Node<{ scope: string; width: number }>>): JSX.Element {
  const { scope, width } = data;
  return (
    <div
      style={{
        width,
        height: 24,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#a5b0bc',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        borderBottom: '1px dashed #30363d',
        pointerEvents: 'none',
        fontFamily: 'ui-monospace, monospace',
      }}
    >
      {scope}
    </div>
  );
}

const nodeTypes = { service: ServiceNodeView, band: BandLabelView };

/**
 * Persist the pan/zoom viewport across dev-server reloads so a source-code
 * edit (which triggers a `full-reload` from the `virtual:dep-graph` plugin)
 * doesn't wipe the position the user carefully panned to. Scoped to
 * `sessionStorage` so each fresh browser session starts with `fitView`.
 */
const VIEWPORT_STORAGE_KEY = 'agent-core-v2:dep-graph:viewport';

function loadViewport(): Viewport | undefined {
  try {
    const raw = sessionStorage.getItem(VIEWPORT_STORAGE_KEY);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as Partial<Viewport> | null;
    if (
      parsed === null ||
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number' ||
      typeof parsed.zoom !== 'number'
    ) {
      return undefined;
    }
    return { x: parsed.x, y: parsed.y, zoom: parsed.zoom };
  } catch {
    return undefined;
  }
}

function saveViewport(v: Viewport): void {
  try {
    sessionStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify(v));
  } catch {
    // Storage disabled (private mode / quota) — silently drop; the graph
    // still works, it just won't remember the viewport across reloads.
  }
}

function passesFilter(
  service: ServiceNode,
  filters: FilterState,
  connected: Set<string>,
): boolean {
  if (!filters.scopes.has(service.scope)) return false;
  if (filters.hiddenDomains.has(service.domain)) return false;
  // NOTE: search intentionally does NOT filter here — it drives the
  // highlight/dim treatment below so context around a hit stays visible.
  if (filters.hideOrphans && !connected.has(service.id)) return false;
  return true;
}

/**
 * Case-insensitive substring match across the identity fields and public
 * surface. Kept close to `passesFilter` so the two search-related pieces
 * (highlight input, matches predicate) stay obviously in sync.
 */
function matchesSearch(service: ServiceNode, query: string): boolean {
  const members = service.publicMembers ? ` ${service.publicMembers.join(' ')}` : '';
  const hay = `${service.token} ${service.impl} ${service.domain}${members}`.toLowerCase();
  return hay.includes(query);
}

export function GraphView({
  graph,
  filters,
  selectedId,
  onSelect,
}: GraphViewProps): JSX.Element {
  // Compute once at mount so a re-render that adds nodes doesn't yank the
  // viewport back to the stored value while the user is panning.
  const initialViewport = useMemo(() => loadViewport(), []);

  const { nodes, edges, selectedService, selectedEdges } = useMemo(() => {
    // Which edges survive the edge-kind filter? Unresolved edges are kept: the
    // analyzer now synthesises an interface-only node for each unresolved token
    // (rendered with a distinct border), so their `to` resolves to a real node
    // instead of dangling. Edges whose endpoint is filtered out are dropped
    // below via the `visibleIds` check.
    const survivingEdges: Edge[] = graph.edges.filter((e) => filters.kinds.has(e.kind));

    // Node ids that appear on either end of any surviving edge — for the
    // orphan filter.
    const connected = new Set<string>();
    for (const e of survivingEdges) {
      connected.add(e.from);
      connected.add(e.to);
    }

    const visibleServices = graph.services.filter((s) =>
      passesFilter(s, filters, connected),
    );
    const visibleIds = new Set(visibleServices.map((s) => s.id));

    // Also drop edges whose endpoint is not in the visible set.
    const finalEdges = survivingEdges.filter(
      (e) => visibleIds.has(e.from) && visibleIds.has(e.to),
    );

    // Ports depend on the *rendered* edges: a port with no visible edge is
    // dead weight on the node, so we compute after filter+visibility.
    const ports = computeServicePorts(visibleServices, finalEdges);

    // Compute the two focus drivers:
    //   • `selectedId` — the click-selected node (0 or 1 at a time).
    //   • `matched`    — every node whose identity or public surface hits
    //                     the current search string.
    // Their neighbours (nodes touched by any surviving edge) are folded in
    // so the graph keeps enough context around a hit to be readable —
    // this is the "act like a click" behaviour: nothing disappears, just
    // dims. `focused` is the union used to decide dim vs bright.
    const searchQuery = filters.search.trim().toLowerCase();
    const matched = new Set<string>();
    if (searchQuery) {
      for (const s of visibleServices) {
        if (matchesSearch(s, searchQuery)) matched.add(s.id);
      }
    }

    const focused = new Set<string>();
    const seedFocus = (id: string): void => {
      focused.add(id);
      for (const e of finalEdges) {
        if (e.from === id) focused.add(e.to);
        if (e.to === id) focused.add(e.from);
      }
    };
    if (selectedId !== undefined) seedFocus(selectedId);
    for (const id of matched) seedFocus(id);

    const focusActive = selectedId !== undefined || matched.size > 0;

    const layout = layoutDagre(visibleServices, finalEdges, {
      groupByScope: filters.groupByScope,
      nodeSize: (id) => {
        const p = ports.get(id);
        return { width: NODE_WIDTH, height: p ? nodeHeight(p) : HEADER_HEIGHT };
      },
    });
    const pos = layout.positions;

    const rfNodes: Node[] = visibleServices.map(
      (service): Node<ServiceNodeData> => ({
        id: service.id,
        type: 'service',
        position: pos.get(service.id) ?? { x: 0, y: 0 },
        data: {
          service,
          selected: service.id === selectedId,
          matched: matched.has(service.id),
          dim: focusActive && !focused.has(service.id),
          ports: ports.get(service.id) ?? {
            inPorts: [],
            outPorts: [],
            connectedIn: new Set<string>(),
          },
        },
      }),
    );

    // If grouped, add one non-interactive label node above each band so the
    // three columns are self-labeling.
    if (layout.bands) {
      const ys = [...pos.values()].map((p) => p.y);
      const minY = ys.length > 0 ? Math.min(...ys) : 0;
      for (const band of layout.bands) {
        rfNodes.push({
          id: `band::${band.scope}`,
          type: 'band',
          position: { x: band.x, y: minY - 40 },
          data: { scope: band.scope, width: Math.max(band.width, 120) },
          draggable: false,
          selectable: false,
          focusable: false,
        });
      }
    }

    const rfEdges: RFEdge[] = [];
    for (const e of finalEdges) {
      const style = EDGE_STYLE[e.kind];
      // With a focus (click or search) active, an edge is bright when both
      // ends are in the focus set — i.e. it either sits directly on a hit
      // or bridges two things adjacent to a hit. When no focus is active
      // every edge stays at its default opacity.
      const isHighlighted = focusActive && focused.has(e.from) && focused.has(e.to);
      // Group refs by (fromMethod, effectiveToMethod) so identical method
      // pairs on different lines collapse into a single arrow between the
      // same two handles instead of stacking.
      const pairs = new Map<
        string,
        { fromMethod: string | undefined; toMethod: string | undefined }
      >();
      for (const ref of e.refs) {
        const toMethod = effectiveToMethod(e.kind, ref.toMethod);
        const key = `${ref.fromMethod ?? ''}|${toMethod ?? ''}`;
        if (!pairs.has(key)) pairs.set(key, { fromMethod: ref.fromMethod, toMethod });
      }
      for (const [key, pair] of pairs) {
        const sourceHandle = pair.fromMethod ? `out:${pair.fromMethod}` : 'default-source';
        const targetHandle = pair.toMethod ? `in:${pair.toMethod}` : 'default-target';
        rfEdges.push({
          id: `${e.from}::${e.kind}::${e.to}::${key}`,
          source: e.from,
          target: e.to,
          sourceHandle,
          targetHandle,
          style: {
            stroke: style.color,
            strokeWidth: isHighlighted ? 2.2 : 1.2,
            strokeDasharray: style.dashed ? '4 3' : undefined,
            opacity: focusActive ? (isHighlighted ? 1 : 0.1) : 0.75,
          },
          animated: false,
        });
      }
    }

    const selectedService = selectedId
      ? graph.services.find((s) => s.id === selectedId)
      : undefined;
    const selectedEdges = selectedId
      ? finalEdges.filter((e) => e.from === selectedId || e.to === selectedId)
      : [];

    return { nodes: rfNodes, edges: rfEdges, selectedService, selectedEdges };
  }, [graph, filters, selectedId]);

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        // Only `fitView` on the very first mount of a fresh browser session.
        // Once a viewport is remembered, hand it to React Flow as
        // `defaultViewport` so the pan/zoom the user last landed on is
        // preserved across dev-server reloads.
        {...(initialViewport
          ? { defaultViewport: initialViewport }
          : { fitView: true })}
        onMoveEnd={(_, viewport) => saveViewport(viewport)}
        minZoom={0.1}
        maxZoom={1.6}
        onNodeClick={(_, node) => {
          if (node.id.startsWith('band::')) return;
          onSelect(node.id);
        }}
        onPaneClick={() => onSelect(undefined)}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} color="#30363d" />
        <MiniMap
          pannable
          zoomable
          style={{ background: '#151b23' }}
          nodeColor={(n) => {
            if (n.id.startsWith('band::')) return 'transparent';
            const service = (n.data as ServiceNodeData | undefined)?.service;
            if (!service) return '#7d8590';
            return service.unresolved ? '#f85149' : SCOPE_STYLE[service.scope].color;
          }}
        />
        <Controls showInteractive={false} style={{ background: '#151b23' }} />
      </ReactFlow>
      {selectedService && (
        <ServicePanel
          service={selectedService}
          graph={graph}
          edges={selectedEdges}
          onClose={() => onSelect(undefined)}
        />
      )}
    </>
  );
}

interface ServicePanelProps {
  service: ServiceNode;
  graph: Graph;
  edges: Edge[];
  onClose: () => void;
}

function ServicePanel({ service, graph, edges, onClose }: ServicePanelProps): JSX.Element {
  const outgoing = edges.filter((e) => e.from === service.id);
  const incoming = edges.filter((e) => e.to === service.id && e.from !== service.id);
  const byId = new Map(graph.services.map((s) => [s.id, s]));
  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 360,
        maxHeight: 'calc(100vh - 24px)',
        overflowY: 'auto',
        background: 'rgba(21,27,35,0.96)',
        border: '1px solid #30363d',
        borderRadius: 8,
        padding: 14,
        fontSize: 12,
        boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{service.impl}</div>
          {service.unresolved ? (
            <div style={{ color: '#f85149', fontSize: 11, marginTop: 2 }}>
              No implementation registered
            </div>
          ) : (
            <div style={{ color: '#a5b0bc', fontSize: 11 }}>{service.token}</div>
          )}
          <div style={{ color: '#7d8590', fontSize: 11 }}>
            <b>{service.scope}</b> · {service.domain}
          </div>
          {!service.unresolved && (
            <div style={{ color: '#7d8590', fontSize: 10, marginTop: 4, wordBreak: 'break-all' }}>
              {service.file}:{service.line}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#7d8590',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      <EdgeList
        title={`out (${outgoing.length})`}
        edges={outgoing}
        direction="out"
        byId={byId}
      />
      <EdgeList
        title={`in (${incoming.length})`}
        edges={incoming}
        direction="in"
        byId={byId}
      />
    </div>
  );
}

interface EdgeListProps {
  title: string;
  edges: Edge[];
  direction: 'in' | 'out';
  byId: Map<string, ServiceNode>;
}

function EdgeList({ title, edges, direction, byId }: EdgeListProps): JSX.Element {
  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          color: '#7d8590',
          marginBottom: 4,
          letterSpacing: 0.5,
        }}
      >
        {title}
      </div>
      {edges.length === 0 && <div style={{ color: '#7d8590', fontSize: 11 }}>—</div>}
      {edges.map((e) => {
        const peerId = direction === 'out' ? e.to : e.from;
        const peer = byId.get(peerId);
        const label = peer ? `${peer.impl} (${peer.token})` : peerId;
        const methodRefs = e.refs.filter((r) => r.toMethod !== undefined || r.fromMethod !== undefined);
        return (
          <div key={`${e.from}::${e.kind}::${e.to}`} style={{ padding: '3px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: 3,
                  borderTop: `${EDGE_STYLE[e.kind].dashed ? '2px dashed' : '2px solid'} ${
                    EDGE_STYLE[e.kind].color
                  }`,
                }}
              />
              <span style={{ color: '#7d8590', fontSize: 10, minWidth: 62 }}>{e.kind}</span>
              <span
                style={{
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 11,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  flex: 1,
                }}
              >
                {label}
              </span>
              <span style={{ color: '#7d8590', fontSize: 10 }}>×{e.refs.length}</span>
            </div>
            {methodRefs.length > 0 && (
              <details style={{ marginLeft: 20, marginTop: 2 }}>
                <summary
                  style={{
                    fontSize: 10,
                    color: '#8b949e',
                    cursor: 'pointer',
                    listStyle: 'revert',
                  }}
                >
                  {methodRefs.length} call{methodRefs.length === 1 ? '' : 's'}
                </summary>
                <div style={{ marginTop: 3 }}>
                  {methodRefs.map((r, i) => (
                    <div
                      key={`${r.file}:${r.line}:${i}`}
                      style={{
                        fontFamily: 'ui-monospace, monospace',
                        fontSize: 10,
                        color: '#a5b0bc',
                        padding: '1px 0',
                      }}
                    >
                      {direction === 'out' ? (
                        <>
                          <span>{r.fromMethod ?? '?'}</span>
                          <span style={{ color: '#6e7681' }}>{' → '}</span>
                          <span style={{ color: '#e6edf3' }}>{r.toMethod ?? '?'}</span>
                        </>
                      ) : (
                        <>
                          <span style={{ color: '#e6edf3' }}>{r.fromMethod ?? '?'}</span>
                          <span style={{ color: '#6e7681' }}>{' → '}</span>
                          <span>{r.toMethod ?? '?'}</span>
                        </>
                      )}
                      <span style={{ color: '#6e7681' }}>{`  (:${r.line})`}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Single delivery protocol used by host instructions and optional capability lookup. */
export const RICH_ANSWER_GUIDE = `Cindy can render a streaming component document directly in an assistant progress message or final answer. You choose content and layout; ordinary Markdown remains available. No HTML file or extra model call is needed.

Your canvas is an inline, progressively rendered part of the conversation, on Cindy's own surface. Layout, hierarchy, typography and spacing are yours; colors and backgrounds belong to Cindy so every answer stays calm and consistent with the application.

Every answer must work across devices and modes. The same stored answer is shown in a desktop message column (about 560–900 px wide) and on phones (about 320–430 px wide), and is often generated on one device and read later on another. It is shown in light and dark mode, and the user can switch modes at any time after generation. Do not design for the device or mode you assume the user has now.
- Layout: keep the answer readable at 320 px without horizontal scrolling. Prefer unset or percentage widths; use fixed pixel sizes only for small elements. Below 600 px, rows and grids become one column unless mobileColumns sets more; decide what should stay side by side on a phone. Cindy keeps nodes within the available width, so oversized fixed widths shrink rather than overflow.
- Color: answers have no backgrounds or custom color values; Cindy draws every color from its theme, so both modes follow automatically. Where color carries meaning, name a role: "primary", "secondary" or "tertiary" for text emphasis, and "success", "warning" or "danger" only for results, cautions and problems. Other color values are ignored. When asked for a colorful or themed look, build it from layout, typography, icons and spacing instead of colors.

To use components, place newline-delimited JSON operations inside a cindy-ui fenced block. Each complete line is rendered immediately; do not wait for a whole document. A code example must be nested inside a longer outer Markdown fence so it stays an example.

Each block starts seq=1 and increments by one. Its first operation has version:1. Node id: 1–80 letters/digits/underscore/hyphen, stable across edits. Operations:
- create: {seq,version:1,op:"create",id,kind,parent?,index?,props?}. Omit parent for root. Create containers before children.
- append: {seq,op:"append",id,text} appends text to text/markdown/heading/code/math/diagram.
- patch: {seq,op:"patch",id,props} changes only supplied properties. Use this for local revisions; do not repeat whole blocks.
- move: {seq,op:"move",id,parent:"root"|containerId,index?}.
- remove: {seq,op:"remove",id} removes the subtree.

Components and props (no arbitrary HTML, CSS, scripts or tool access):
- text/heading: text; markdown: text supports lists/tables/links.
- icon: name (mail, calendar, folder, chart, check, info, clock, location, coffee, image, users, star), label, text?. size?, strokeWidth?.
- stack/group: vertical children. row/grid: columns?, mobileColumns?, weights? (relative column widths); layout:"aside" for side-by-side content.
- divider.
- image/video/audio: src (existing managed reference, URL or task file), alt, caption. Reuse actual media; never invent asset URLs or embed base64 data. Video src accepts a playable media file URL or a YouTube watch/share/shorts URL (the host uses the site player). Other website pages are links, not video files; link to those pages instead of treating them as media bytes.
- code: text, language. math: text (LaTeX). diagram: text (Mermaid).
- stat: label, value, prefix?, suffix?.
- chart: label, variant:"bar"|"line", data:[{label,value}], color? (role), colors? (bar roles), height?, yMin?, yMax?, includeZero?, ticks?, decimals?, showValues?, showLabels?, showPoints?, pointRadius?, strokeWidth?, showGrid?, left?, right?, top?, bottom?. Line domains fit the data unless specified. Chart options are optional; use svg for other chart types or custom composition.
- svg: label/alt, viewBox:[x,y,width,height], shapes:[{type,...attributes}]. Shape types: path, rect, circle, ellipse, line, polyline, polygon, text. Attributes: x,y,x1,y1,x2,y2,width,height,rx,ry,cx,cy,r,d,points,fill and stroke (a color role or "none"),strokeWidth,strokeDasharray,strokeLinecap,strokeLinejoin,opacity,fillOpacity,strokeOpacity,fontSize,fontWeight,letterSpacing,textAnchor,transform. text shapes use text. Coordinates and paths are model-designed; the viewBox scales to the available width. No script, events, HTML, external references or URL paints.
- range: label, bind?, min,max,step,default,suffix?. input: label,bind?,default,placeholder. check: label,bind?,default boolean. select: label,bind?,default,options:[{label,value}].
- details: label,default boolean,children. tabs: children are containers with label; default is selected child id.
- button/form: label,set:{stateKey:expression}. Button or form submit only changes local UI values. It does not execute tools, navigate, or send messages.

Every node accepts props.style (style beside props is also accepted) with optional color (a role), opacity, width/maxWidth/minWidth/height/minHeight/maxHeight, padding/paddingTop/paddingRight/paddingBottom/paddingLeft, marginTop/marginBottom, gap, borderRadius/borderWidth/borderStyle (borders are 1 px in Cindy's border color), fontSize/fontWeight/fontFamily/fontStyle/lineHeight/letterSpacing/textAlign/textDecorationLine, flexGrow/flexShrink, alignItems/justifyContent/flexDirection/flexWrap. Lengths are numbers in display pixels; dimensions also accept percentages. lineHeight up to 4 is a font-size multiplier; larger values are pixels. Model-specified styles override host defaults within these limits. Custom visualizations and icons can use svg primitives instead of the preset chart/icon. SVG is structured data, not a markup string.

bind defaults to node id. User values persist locally per account/device/message and take precedence over later model defaults. They are not automatically sent to the model or synchronized across viewing devices. Do not ask for credentials in these controls.
value and chart data may use a scalar, {ref:"stateKeyOrComputedNodeId"}, or {op,args:[...]}. Supported op: add,sub,mul,div,min,max,lt,gt,eq,if,concat. References can target input bindings or computed stat/text node ids, including nodes declared later. Never create circular references. Missing or invalid references are unavailable, not zero. No JavaScript evaluation.

Operation syntax example, not a prescribed answer layout (each object is one line within the cindy-ui block):
{"version":1,"seq":1,"op":"create","id":"months","kind":"range","props":{"label":"Months","min":1,"max":24,"default":6}}
{"seq":2,"op":"create","id":"cost","kind":"stat","props":{"label":"Total","prefix":"¥","value":{"op":"mul","args":[{"ref":"months"},20]}}}
{"seq":3,"op":"patch","id":"cost","props":{"value":{"op":"mul","args":[{"ref":"months"},18]}}}

Keep blocks under 128 KB, with no more than 2048 nodes and depth 32. Finish each line before starting the next. Media loads via the existing host path. Interrupted output keeps committed nodes; incomplete lines wait for completion. Unknown or malformed operations show a local readable fallback, never execute code. New Cindy clients render components; older clients may show the fenced source. Use Markdown when the receiving channel does not support components.`;

/** Host addition only: native CLI instructions and execution remain unchanged. */
export const ANSWER_DELIVERY_PROMPT = `## Cindy answer delivery
Create beautiful, elegant, readable answers. You decide the layout, typography and charts within Cindy's colors, following the user's request and presentation preferences. Cindy's component defaults are fallbacks, not design requirements. These capabilities apply to tasks and companions without changing your tool use or native workflow.

The component protocol is rendered on Cindy conversation surfaces. External channels retain their required formats. Controls hold local viewing state; they do not execute work or send input to the model.

${RICH_ANSWER_GUIDE}`;

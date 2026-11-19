# Icon-only buttons show their names in a tooltip instead of a browser title

Date: 2026-11-19

Buttons and links that show only an icon now show their name in a small label beside them, on keyboard focus at once and on hover
after a short delay, in place of the browser's own `title` text, which keyboard users never saw ([spec 042](../../specs/042-tooltip/spec.md)).
This covers the patient page's two Refresh buttons, the reports filter's two buttons, the "About…" information button, the sidebar's
collapse control, and, while the sidebar is collapsed to icons on a desktop-width window, New chat, each destination, Follow-ups and the
account button. The component is built on `@radix-ui/react-tooltip` (one new package), adapted from Arc UI with its MIT licence kept beside
it. The sidebar loads the tooltip's code on demand, so the library is its own file and the first file every page loads stays about 111 kB gzipped. A tooltip only repeats a
control's own name; no fact, status, reason or safety statement lives only in one. Names, order and behaviour of every control are
unchanged. No word, route, role, API, schema or stored data changes.

import { createRoot } from "react-dom/client";
import SmartEvidencePage, { takeSmartSession } from "./SmartEvidencePage.js";
const token = takeSmartSession();
createRoot(document.getElementById("root")!).render(
  <SmartEvidencePage sessionToken={token} />,
);

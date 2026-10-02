import { useState } from "react";
/** Instance-local panel state; runtime/chat integration is explicitly unavailable until j18/j22. */
export function useOMChatPane(required: Record<string, never>) {
 const [open, setOpen] = useState(false);
 const toggle = () => setOpen(value => !value);
 return { open, toggle };
}

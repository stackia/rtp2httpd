/** A keystroke aimed at a text field or editable content belongs to it, not to player shortcuts. */
export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!target || !("tagName" in target)) return false;
  const tagName = String((target as { tagName?: unknown }).tagName).toUpperCase();
  return (
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT" ||
    !!(target as { isContentEditable?: boolean }).isContentEditable
  );
}

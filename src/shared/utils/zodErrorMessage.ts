import { ZodError } from "zod";

/**
 * Human-readable message from Zod for API responses and toasts.
 */
export function formatZodErrorMessage(error: ZodError): string {
  const flat = error.flatten();
  const parts: string[] = [];

  for (const msg of flat.formErrors) {
    if (msg) parts.push(msg);
  }

  for (const [field, msgs] of Object.entries(flat.fieldErrors)) {
    if (Array.isArray(msgs) && msgs.length > 0) {
      const label = field === "_root" ? "Request" : field;
      parts.push(`${label}: ${msgs.join(", ")}`);
    }
  }

  if (parts.length > 0) {
    return parts.join("; ");
  }

  const issues = error.issues;
  const first = issues[0];
  if (first?.message) {
    const path = first.path?.length ? `${first.path.join(".")}: ` : "";
    return `${path}${first.message}`.trim();
  }

  return "Invalid input";
}

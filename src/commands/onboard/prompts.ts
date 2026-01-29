/**
 * Onboard wizard prompts wrapper
 * Uses @clack/prompts for interactive CLI
 */
import * as p from "@clack/prompts";
import pc from "picocolors";

export { p, pc };

export class WizardCancelledError extends Error {
  constructor(message = "Wizard cancelled") {
    super(message);
    this.name = "WizardCancelledError";
  }
}

export function guardCancel<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel(pc.red("Onboarding cancelled."));
    process.exit(0);
  }
  return value;
}

export async function intro(title: string): Promise<void> {
  p.intro(pc.cyan(title));
}

export async function outro(message: string): Promise<void> {
  p.outro(message);
}

export async function note(message: string, title?: string): Promise<void> {
  p.note(message, title);
}

export async function spinner() {
  return p.spinner();
}

export async function confirm(options: {
  message: string;
  initialValue?: boolean;
}): Promise<boolean> {
  const result = await p.confirm({
    message: options.message,
    initialValue: options.initialValue ?? false,
  });
  return guardCancel(result);
}

export async function text(options: {
  message: string;
  placeholder?: string;
  initialValue?: string;
  validate?: (value: string) => string | void;
}): Promise<string> {
  const result = await p.text({
    message: options.message,
    placeholder: options.placeholder,
    initialValue: options.initialValue,
    validate: options.validate,
  });
  return guardCancel(result);
}

export async function password(options: {
  message: string;
  validate?: (value: string) => string | void;
}): Promise<string> {
  const result = await p.password({
    message: options.message,
    validate: options.validate,
  });
  return guardCancel(result);
}

export async function select<T>(options: {
  message: string;
  options: Array<{ value: T; label: string; hint?: string }>;
  initialValue?: T;
}): Promise<T> {
  const result = await p.select({
    message: options.message,
    options: options.options as any,
    initialValue: options.initialValue,
  });
  return guardCancel(result);
}

export async function multiselect<T>(options: {
  message: string;
  options: Array<{ value: T; label: string; hint?: string }>;
  required?: boolean;
  initialValues?: T[];
}): Promise<T[]> {
  const result = await p.multiselect({
    message: options.message,
    options: options.options as any,
    required: options.required ?? false,
    initialValues: options.initialValues,
  });
  return guardCancel(result);
}

export function printHeader(): void {
  console.log(pc.cyan([
    "",
    "██╗    ██╗ ██████╗ ██████╗ ██████╗ ",
    "██║    ██║██╔═══██╗██╔══██╗██╔══██╗",
    "██║ █╗ ██║██║   ██║██████╔╝██████╔╝",
    "██║███╗██║██║   ██║██╔═══╝ ██╔══██╗",
    "╚███╔███╔╝╚██████╔╝██║     ██║  ██║",
    " ╚══╝╚══╝  ╚═════╝ ╚═╝     ╚═╝  ╚═╝",
    "",
    "   🚀 WOPR - War Operations Planned Response",
    "",
  ].join("\n")));
}

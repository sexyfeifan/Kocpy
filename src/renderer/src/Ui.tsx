import type {
  ButtonHTMLAttributes,
  ComponentType,
  ReactNode,
  SVGProps,
} from "react";
import { FolderOpen } from "lucide-react";
import { statusText } from "../../common/status";

type IconComponent = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number }
>;

const closeLabels = /^(关闭.*|取消|稍后|后台继续)$/;

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: string;
  disabledReason?: string;
};

/**
 * Shared application button. Keeping native button props here preserves
 * keyboard behaviour while enforcing the same visual and accessibility
 * contract in every renderer module.
 */
export function Button({
  children,
  kind = "",
  className = "",
  title,
  type = "button",
  disabled,
  disabledReason,
  ...props
}: ButtonProps) {
  const classes = ["btn", kind, className].filter(Boolean).join(" ");
  const visibleLabel =
    typeof children === "string" ? children.trim() : undefined;
  const accessibleLabel = props["aria-label"] || title || visibleLabel;
  const isIconOnly = kind.split(/\s+/).includes("icon");
  const dialogClose = Boolean(
    accessibleLabel && closeLabels.test(String(accessibleLabel).trim()),
  );
  const effectiveTitle =
    title ||
    (disabled
      ? disabledReason || "当前条件尚未满足，或操作仍在进行中"
      : undefined);
  return (
    <button
      {...props}
      type={type}
      className={classes}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      aria-label={
        props["aria-label"] || (isIconOnly ? accessibleLabel : undefined)
      }
      data-dialog-close={dialogClose || undefined}
      title={effectiveTitle}
    >
      {children}
    </button>
  );
}

export function Empty({
  icon: Icon = FolderOpen,
  title,
  detail,
  action,
}: {
  icon?: IconComponent;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty" role="status">
      <span className="empty-icon" aria-hidden="true">
        <Icon size={28} strokeWidth={1.3} />
      </span>
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  );
}

export function Badge({ status }: { status: string }) {
  const label = statusText[status] || status;
  return (
    <span className={`badge ${status}`} aria-label={label}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

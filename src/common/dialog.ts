export const modalDialogSelector =
  '[role="dialog"],[role="alertdialog"]';

export const dialogControlName = (button: Element) =>
  (
    button.getAttribute("aria-label") ||
    button.getAttribute("title") ||
    button.textContent ||
    ""
  ).trim();

export const isDialogCloseControl = (button: Element) =>
  button.getAttribute("data-dialog-close") === "true" ||
  /^(关闭.*|取消|稍后|后台继续)$/.test(dialogControlName(button));

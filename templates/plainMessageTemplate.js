const escapeHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

export const buildPlainMessageEmail = (data = {}) => {
  const logoUrl = process.env.BYEXPRESS_LOGO_URL;
  const subject = String(data.subject || "A message from ByExpress").trim();
  const message = String(data.message || "").trim();
  const textLines = [
    message,
    "",
    "Best regards,",
    "ByExpress Spain & France",
  ];

  if (data.unsubscribeUrl) {
    textLines.push(
      "",
      `If you do not want to receive our transport offers any more, please click here: ${data.unsubscribeUrl}`,
    );
  }

  const text = textLines.join("\n");

  const html = `
<!doctype html>
<html>
  <body style="margin:0; padding:0; background:#f4f7fb; font-family: Arial, Helvetica, sans-serif; color:#172033;">
    <div style="display:none; max-height:0; overflow:hidden;">${escapeHtml(subject)}</div>
    <div style="max-width:1120px; margin:0 auto; padding:28px 16px;">
      <div style="background:#ffffff; border:1px solid #d8e3ef; border-radius:12px; overflow:hidden;">
        <div style="background:#0b2a5b; padding:22px 28px;">
          ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="ByExpress" style="display:block; max-width:210px; height:auto;" />` : `<div style="font-size:30px; font-weight:700;"><span style="color:#f05a3f;">By</span><span style="color:#ffffff;">Express</span></div>`}
        </div>

        <div style="padding:28px;">
          <div style="font-size:16px; line-height:1.6; white-space:pre-line; margin:0 0 24px;">${escapeHtml(message)}</div>

          <p style="font-size:15px; line-height:1.5; margin:0;">Best regards,</p>
          <p style="font-size:15px; line-height:1.5; font-weight:700; color:#0b2a5b; margin:0;">ByExpress Spain &amp; France</p>
        </div>
      </div>

      ${data.unsubscribeUrl ? `<p style="font-size:13px; color:#64748b; line-height:1.5; margin:16px 4px 0;">If you do not want to receive our transport offers any more, please <a href="${escapeHtml(data.unsubscribeUrl)}" style="color:#2563eb;">click here</a>.</p>` : ""}
    </div>
  </body>
</html>`;

  return { subject, text, html };
};

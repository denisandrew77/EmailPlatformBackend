const escapeHtml = (value) => {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
};

const formatDate = (dateValue) => {
    if (!dateValue) return "";

    const date = new Date(dateValue);
    if (!Number.isNaN(date.getTime())) {
        return `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getFullYear()).slice(-2)}`;
    }

    return String(dateValue);
};

const formatLocation = (location = {}) => {
    const country = escapeHtml(location.country);
    const postalCode = escapeHtml(location.postalCode);
    const city = escapeHtml(location.city);
    const date = escapeHtml(formatDate(location.date));
    const time = escapeHtml(location.time);

    return `${country}-${postalCode} - ${city} - ${date} - ${time}`;
};

const buildSubject = (data) => {
    const loadingCountry = data.loading?.country ?? "";
    const loadingPostalCode = data.loading?.postalCode ?? "";
    const deliveryCountry = data.delivery?.country ?? "";
    const deliveryPostalCode = data.delivery?.postalCode ?? "";

    return `Transport from ${loadingCountry} ${loadingPostalCode} to ${deliveryCountry} ${deliveryPostalCode}`;
};

const formatGoodsLine = (goods = []) => {
    const totalWeight = goods.reduce((sum, good) => sum + Number(good.weight || 0), 0);
    const totalNumber = goods.reduce((sum, good) => sum + Number(good.number || 0), 0);
    const firstGood = goods[0] ?? {};
    const goodsType = totalNumber === 1 ? escapeHtml(firstGood.type || "Pallet") : escapeHtml(firstGood.type || "Pallets");
    const stackText = goods.some((good) => good.stack) ? "yes" : "no";

    return `${totalWeight} kgs - ${totalNumber} ${goodsType} - ${escapeHtml(firstGood.length)} x ${escapeHtml(firstGood.width)} x ${escapeHtml(firstGood.height)} (LxWxH) - stack - ${stackText}`;
};

const buildText = (data) => {
    return [
        "Hello,",
        "",
        "Can i have your best price and service option for:",
        "",
        `Load Order: ${data.loadOrder}`,
        "",
        `Loading: ${formatLocation(data.loading)}`,
        "",
        `Delivery: ${formatLocation(data.delivery)}`,
        "",
        "Goods:",
        formatGoodsLine(data.goods),
        "",
        "Thank you for your answer.",
        "",
        "Best regards,",
        "ByExpress Spain & France",
    ].join("\n");
};

export const buildQuotationRequestEmail = (data) => {
    const logoUrl = process.env.BYEXPRESS_LOGO_URL;
    const subject = data.subject ?? buildSubject(data);
    const text = buildText(data);

    const html = `
<!doctype html>
<html>
  <body style="margin:0; padding:0; background:#f4f7fb; font-family: Arial, Helvetica, sans-serif; color:#172033;">
    <div style="display:none; max-height:0; overflow:hidden;">${escapeHtml(subject)}</div>
    <div style="max-width:720px; margin:0 auto; padding:28px 16px;">
      <div style="background:#ffffff; border:1px solid #d8e3ef; border-radius:12px; overflow:hidden;">
        <div style="background:#0b2a5b; padding:22px 28px;">
          ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="ByExpress" style="display:block; max-width:210px; height:auto;" />` : `<div style="font-size:30px; font-weight:700;"><span style="color:#f05a3f;">By</span><span style="color:#ffffff;">Express</span></div>`}
        </div>

        <div style="padding:28px;">
          <p style="font-size:16px; line-height:1.5; margin:0 0 16px;">Hello,</p>
          <p style="font-size:16px; line-height:1.5; margin:0 0 24px;">Can i have your best price and service option for the transport below?</p>

          <div style="border:1px solid #e2e8f0; border-radius:10px; background:#f8fafc; padding:18px 20px; margin:0 0 22px;">
            <div style="font-size:12px; font-weight:700; color:#64748b; text-transform:uppercase; margin-bottom:4px;">Load order</div>
            <div style="font-size:24px; font-weight:800; color:#0b2a5b;">${escapeHtml(data.loadOrder)}</div>
          </div>

          <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%; border-collapse:collapse; margin:0 0 22px;">
            <tr>
              <td style="width:50%; vertical-align:top; padding:0 8px 0 0;">
                <div style="border:1px solid #e2e8f0; border-radius:10px; padding:16px;">
                  <div style="font-size:12px; font-weight:700; color:#2563eb; text-transform:uppercase; margin-bottom:8px;">Loading</div>
                  <div style="font-size:15px; line-height:1.6;">${formatLocation(data.loading)}</div>
                </div>
              </td>
              <td style="width:50%; vertical-align:top; padding:0 0 0 8px;">
                <div style="border:1px solid #e2e8f0; border-radius:10px; padding:16px;">
                  <div style="font-size:12px; font-weight:700; color:#2563eb; text-transform:uppercase; margin-bottom:8px;">Delivery</div>
                  <div style="font-size:15px; line-height:1.6;">${formatLocation(data.delivery)}</div>
                </div>
              </td>
            </tr>
          </table>

          <div style="border:1px solid #e2e8f0; border-radius:10px; padding:16px; margin:0 0 24px;">
            <div style="font-size:12px; font-weight:700; color:#2563eb; text-transform:uppercase; margin-bottom:8px;">Goods</div>
            <div style="font-size:15px; line-height:1.6;">${formatGoodsLine(data.goods)}</div>
          </div>

          <p style="font-size:16px; line-height:1.5; margin:0 0 24px;">Thank you for your answer.</p>

          <p style="font-size:15px; line-height:1.5; margin:0;">Best regards,</p>
          <p style="font-size:15px; line-height:1.5; font-weight:700; color:#0b2a5b; margin:0;">ByExpress Spain &amp; France</p>
        </div>
      </div>

      ${data.unsubscribeUrl ? `<p style="font-size:13px; color:#64748b; line-height:1.5; margin:16px 4px 0;">If you do not want to receive our transport offers any more, please <a href="${escapeHtml(data.unsubscribeUrl)}" style="color:#2563eb;">click here</a>.</p>` : ""}
    </div>
  </body>
</html>`;

    return {
        subject,
        text,
        html,
    };
};

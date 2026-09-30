const getSenderEmail = () => {
    if (!process.env.SMTP2GO_FROM_EMAIL) {
        throw new Error("SMTP2GO_FROM_EMAIL is not configured");
    }

    const senderName = process.env.SMTP2GO_FROM_NAME || "ByExpress";
    return `"${senderName}" <${process.env.SMTP2GO_FROM_EMAIL}>`;
};

export const sendEmail = async ({ to, subject, text, html }) => {
    const apiKey = process.env.SMTP2GO_API_KEY;
    if (!apiKey) throw new Error("SMTP2GO_API_KEY is not configured");

    const recipients = Array.isArray(to) ? to : [to];
    if (!recipients.length || recipients.some((recipient) => typeof recipient !== "string" || !recipient.trim())) {
        throw new Error("Email requires at least one recipient");
    }

    const response = await fetch("https://api.smtp2go.com/v3/email/send", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Smtp2go-Api-Key": apiKey,
        },
        body: JSON.stringify({
            sender: getSenderEmail(),
            to: recipients,
            subject,
            ...(text ? { text_body: text } : {}),
            ...(html ? { html_body: html } : {}),
            fastaccept: false,
        }),
        signal: AbortSignal.timeout(20000),
    });

    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error(`SMTP2GO returned an invalid response (HTTP ${response.status})`);
    }

    const data = result?.data;
    // SMTP2GO can return HTTP 200 even when recipients were rejected.
    if (!response.ok || data?.error || data?.error_code || data?.failed > 0 || data?.failures?.length || data?.succeeded !== recipients.length) {
        throw new Error(`SMTP2GO send failed (HTTP ${response.status}): ${data?.error_code || "recipient acceptance failed"}`);
    }

    return result;
};

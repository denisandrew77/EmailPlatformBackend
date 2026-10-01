import assert from "node:assert/strict";
import test from "node:test";
import { renderEmailTemplate } from "../templates/emailTemplateRenderer.js";

test("plain messages use the quotation email shell and escape custom content", () => {
    const rendered = renderEmailTemplate({
        to: "carrier@example.com",
        template: "plainMessage",
        templateData: {
            message: "Choose <one> category\nThank you",
            unsubscribeUrl: "https://example.com/unsubscribe?token=test",
        },
    });

    assert.equal(rendered.subject, "A message from ByExpress");
    assert.equal(rendered.text, "Choose <one> category\nThank you\n\nBest regards,\nByExpress Spain & France");
    assert.match(rendered.html, /background:#0b2a5b/);
    assert.match(rendered.html, /Choose &lt;one&gt; category\nThank you/);
    assert.match(rendered.html, /Best regards,/);
    assert.match(rendered.html, /click here/);
    assert.doesNotMatch(rendered.text, /Hello,|Thank you for your answer/);
    assert.doesNotMatch(rendered.html, /Hello,|Thank you for your answer/);
    assert.doesNotMatch(rendered.html, /Choose <one>/);
});

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
    assert.equal(
        rendered.text,
        "Choose <one> category\nThank you\n\nBest regards,\nByExpress Spain & France\n\nTo stop receiving transport offers, use this unsubscribe link:\nhttps://example.com/unsubscribe?token=test",
    );
    assert.match(rendered.html, /background:#0b2a5b/);
    assert.match(rendered.html, /Choose &lt;one&gt; category\nThank you/);
    assert.match(rendered.html, /Best regards,/);
    assert.match(rendered.html, /If you do not want to receive our transport offers any more, please <a href="https:\/\/example\.com\/unsubscribe\?token=test"[^>]*>click here<\/a>\./);
    assert.match(rendered.text, /To stop receiving transport offers/);
    assert.match(rendered.text, /https:\/\/example\.com\/unsubscribe\?token=test/);
    assert.doesNotMatch(rendered.text, /Hello,|Thank you for your answer/);
    assert.doesNotMatch(rendered.html, /Hello,|Thank you for your answer/);
    assert.doesNotMatch(rendered.html, /Choose <one>/);
});

test("quotation requests include the unsubscribe link in their plain-text alternative", () => {
    const rendered = renderEmailTemplate({
        to: "carrier@example.com",
        template: "quotationRequest",
        templateData: {
            loadOrder: "Q-100",
            loading: { country: "RO", postalCode: "010101", city: "Bucharest" },
            delivery: { country: "DE", postalCode: "10115", city: "Berlin" },
            goods: [],
            unsubscribeUrl: "https://example.com/unsubscribe?token=quote",
        },
    });

    assert.match(rendered.text, /To stop receiving transport offers/);
    assert.match(rendered.text, /https:\/\/example\.com\/unsubscribe\?token=quote/);
    assert.match(rendered.html, /href="https:\/\/example\.com\/unsubscribe\?token=quote"/);
    assert.match(rendered.html, /If you do not want to receive our transport offers any more, please <a href="https:\/\/example\.com\/unsubscribe\?token=quote"[^>]*>click here<\/a>\./);
});

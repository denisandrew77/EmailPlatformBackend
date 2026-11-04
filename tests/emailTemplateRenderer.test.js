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
        "Choose <one> category\nThank you\n\nBest regards,\nByExpress Spain & France\n\nIf you do not want to receive our transport offers any more, please click here: https://example.com/unsubscribe?token=test",
    );
    assert.match(rendered.html, /background:#0b2a5b/);
    assert.match(rendered.html, /Choose &lt;one&gt; category\nThank you/);
    assert.match(rendered.html, /Best regards,/);
    assert.match(rendered.html, /If you do not want to receive our transport offers any more, please <a href="https:\/\/example\.com\/unsubscribe\?token=test"[^>]*>click here<\/a>\./);
    assert.match(rendered.text, /If you do not want to receive our transport offers any more, please click here: https:\/\/example\.com\/unsubscribe\?token=test/);
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

    assert.match(rendered.text, /If you do not want to receive our transport offers any more, please click here: https:\/\/example\.com\/unsubscribe\?token=quote/);
    assert.match(rendered.text, /https:\/\/example\.com\/unsubscribe\?token=quote/);
    assert.match(rendered.html, /href="https:\/\/example\.com\/unsubscribe\?token=quote"/);
    assert.match(rendered.html, /If you do not want to receive our transport offers any more, please <a href="https:\/\/example\.com\/unsubscribe\?token=quote"[^>]*>click here<\/a>\./);
});

test("quotation calendar dates render identically in every server timezone", () => {
    const originalZone = process.env.TZ;
    try {
        for (const zone of ["UTC", "Europe/Bucharest", "America/Los_Angeles"]) {
            process.env.TZ = zone;
            const rendered = renderEmailTemplate({
                template: "quotationRequest",
                templateData: {
                    loadOrder: 10063,
                    loading: { country: "FR", postalCode: "86100", city: "Chatellerault", date: "2026-11-04", time: "11.00" },
                    delivery: { country: "DE", postalCode: "30855", city: "Langenhagen", date: "2026-11-05", time: "08.00" },
                    goods: [],
                },
            });
            assert.match(rendered.text, /Loading: FR-86100 - Chatellerault - 04\.11\.26 - 11\.00/);
            assert.match(rendered.text, /Delivery: DE-30855 - Langenhagen - 05\.11\.26 - 08\.00/);
            assert.match(rendered.html, /DE-30855 - Langenhagen - 05\.11\.26 - 08\.00/);
        }
    } finally {
        if (originalZone === undefined) delete process.env.TZ;
        else process.env.TZ = originalZone;
    }
});

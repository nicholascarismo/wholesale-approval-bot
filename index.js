import 'dotenv/config';
import boltPkg from '@slack/bolt';

const { App } = boltPkg;

/* =========================
   Slack Socket Mode App
========================= */
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,     // xoxb-...
  appToken: process.env.SLACK_APP_TOKEN,  // xapp-... (connections:write)
  socketMode: true,
  processBeforeResponse: true
});

/* =========================
   Env & Config
========================= */
const WATCH_CHANNEL = process.env.WHOLESALE_APPROVAL_CHANNEL_ID || ''; // change this later to move channels
const SHOPIFY_DOMAIN  = process.env.SHOPIFY_DOMAIN;                    // e.g. carismodesign.myshopify.com
const SHOPIFY_TOKEN   = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_VERSION = process.env.SHOPIFY_API_VERSION || '2025-10';

/* =========================
   Shopify Admin GraphQL
========================= */
async function shopifyGQL(query, variables) {
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}/graphql.json`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
      'Shopify-API-Version': SHOPIFY_VERSION
    },
    body: JSON.stringify({ query, variables })
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Shopify HTTP ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  if (json.errors?.length) throw new Error(`Shopify GQL errors: ${JSON.stringify(json.errors)}`);
  if (json.data?.errors?.length) throw new Error(`Shopify data.errors: ${JSON.stringify(json.data.errors)}`);
  return json.data;
}

const CUSTOMER_TAGS_ADD_GQL = `
  mutation tagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id ... on Customer { id tags(first: 25) { edges { node } } } }
      userErrors { field message }
    }
  }
`;

const CUSTOMER_TAGS_REMOVE_GQL = `
  mutation tagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id ... on Customer { id tags(first: 25) { edges { node } } } }
      userErrors { field message }
    }
  }
`;

async function addCustomerTags({ numericId, tags = [] }) {
  const id = `gid://shopify/Customer/${numericId}`;
  const data = await shopifyGQL(CUSTOMER_TAGS_ADD_GQL, { id, tags });
  const errs = data?.tagsAdd?.userErrors || [];
  if (errs.length) throw new Error(`tagsAdd errors: ${JSON.stringify(errs)}`);
}

async function removeCustomerTags({ numericId, tags = [] }) {
  const id = `gid://shopify/Customer/${numericId}`;
  const data = await shopifyGQL(CUSTOMER_TAGS_REMOVE_GQL, { id, tags });
  const errs = data?.tagsRemove?.userErrors || [];
  if (errs.length) throw new Error(`tagsRemove errors: ${JSON.stringify(errs)}`);
}

/* =========================
   Slack UI helpers
========================= */
function buildButtons({ name, customerId }) {
  const payload = (extra = {}) => JSON.stringify({ name, customerId, ...extra });
  return [
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Approve at 30% (default)' }, style: 'primary', action_id: 'approve_30', value: payload() },
        { type: 'button', text: { type: 'plain_text', text: 'Approve at 25%' }, action_id: 'approve_25', value: payload() },
        { type: 'button', text: { type: 'plain_text', text: 'Other (choose %)' }, action_id: 'approve_other', value: payload() },
        { type: 'button', text: { type: 'plain_text', text: 'Reject' }, style: 'danger', action_id: 'reject', value: payload() }
      ]
    }
  ];
}

// ---- Replace your parseFlowbotMessage with this ----
function parseFlowbotMessage(rawText) {
  const text = String(rawText || '').trim();
  const lines = text.split(/\r?\n/).map(l => l.trim());

  // Trigger detection (strict + fuzzy)
  const strictTrigger = /New wholesale signup, approve directly in this thread:/i.test(text);
  const fuzzyTrigger =
    /New\s+wholesale\s+signup/i.test(text) &&
    (/approve.*thread/i.test(text) || /approve/i.test(text));
  const isTrigger = strictTrigger || fuzzyTrigger;

  // Labels may be styled; value may appear inline or on next line; may be formatted
  const name = extractLabeledValue(lines, /^\*?\s*Name\*?\s*:/i);

  // Get the raw "Customer ID" value (could be `123`, *123*, etc.)
  const idRaw = extractLabeledValue(lines, /^\*?\s*Customer\s*ID\*?\s*:/i);

  // Normalize: strip Slack formatting chars and pull first digit run
  const normalize = (s) => (s || '').replace(/[`*_~<>]/g, '').trim();
  let customerId = '';

  if (idRaw) {
    const m = normalize(idRaw).match(/\d+/);
    if (m) customerId = m[0];
  }
  if (!customerId) {
    // Fallback: scan the full text for "Customer ID: `123`" or similar
    const m2 = text.match(/Customer\s*ID:\s*`?(\d+)`?/i);
    if (m2) customerId = m2[1];
  }

  return { isTrigger: isTrigger && !!customerId, name, customerId };
}

// Collect visible text from text, attachments, and blocks
// ---- Replace / add this helper ----
function collectMessageText(event) {
  const parts = [];

  // Plain text (may be empty for bot messages)
  if (event.text) parts.push(event.text);

  // Attachments (legacy)
  if (Array.isArray(event.attachments)) {
    for (const a of event.attachments) {
      if (a.title) parts.push(a.title);
      if (a.text) parts.push(a.text);
      if (Array.isArray(a.fields)) {
        for (const f of a.fields) {
          if (f.title) parts.push(String(f.title));
          if (f.value) parts.push(String(f.value));
        }
      }
    }
  }

  // Blocks
  if (Array.isArray(event.blocks)) {
    for (const b of event.blocks) {
      if ((b.type === 'section' || b.type === 'header') && b.text?.text) {
        parts.push(b.text.text);
      }
      // Section fields (Flowbot often uses these)
      if (b.type === 'section' && Array.isArray(b.fields)) {
        for (const fld of b.fields) {
          if (fld?.text) parts.push(fld.text);
        }
      }
      // Rich text (Flowbot sometimes posts in rich_text)
      if (b.type === 'rich_text' && Array.isArray(b.elements)) {
        for (const el of b.elements) {
          if (el.type === 'rich_text_section' && Array.isArray(el.elements)) {
            const txt = el.elements.map(e => e.text || '').join('');
            if (txt) parts.push(txt);
          }
        }
      }
    }
  }

  // Initial comment on file shares (belt & suspenders)
  if (event.initial_comment?.comment) {
    parts.push(event.initial_comment.comment);
  }

  return parts.join('\n').trim();
}

// Small utility: find label on a line, capture inline value or on next non-empty line
function extractLabeledValue(lines, labelRegex) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(labelRegex);
    if (m) {
      // inline pattern after :
      const after = line.split(':').slice(1).join(':').trim();
      if (after) return after.replace(/^\*+|\*+$/g, '').trim(); // strip *bold* artifacts
      // else take next non-empty line
      for (let j = i + 1; j < lines.length; j++) {
        const val = lines[j].replace(/^\*+|\*+$/g, '').trim();
        if (val) return val;
      }
    }
  }
  return '';
}


// ===== DEBUG MIDDLEWARE (place above app.event('message')) =====
app.use(async ({ logger, payload, body, context, next }) => {
  try {
    // Only log message-type events to keep noise low
    if (body?.event?.type === 'message') {
      const e = body.event;
      console.log(
        `[evt] type=message subtype=${e.subtype || '-'} ch=${e.channel} ts=${e.ts} from=${e.user || e.bot_id || '-'} text="${(e.text || '').slice(0,120)}"`
      );
    }
  } catch (err) {
    console.error('debug middleware err', err);
  }
  await next();
});

/* =========================
   Events
========================= */
app.event('message', async ({ event, client }) => {
  try {
    if (!WATCH_CHANNEL) return;
    if (event.channel !== WATCH_CHANNEL) return;

    const bodyText = collectMessageText(event);
    if (!bodyText) return;

    const { isTrigger, name, customerId } = parseFlowbotMessage(bodyText);
    if (!isTrigger) return;

    console.log('[wholesale] trigger=%s name="%s" id="%s"', isTrigger, name, customerId);

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts,
      text: `New wholesale signup detected for ${name} (ID ${customerId}). Choose an action:`,
      blocks: buildButtons({ name, customerId })
    });
  } catch (e) {
    console.error('message handler error', e);
  }
});

/* =========================
   Actions (fast ack + do work)
========================= */
app.action('approve_30', async ({ ack, body, client, logger }) => {
  await ack(); // fast
  const { channel, thread_ts } = { channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts };
  const { name, customerId } = JSON.parse(body.actions?.[0]?.value || '{}');

  try {
    await addCustomerTags({ numericId: customerId, tags: ['wholesale30'] });
    await client.chat.postMessage({
      channel, thread_ts,
      text: `✅ Approved *${name}* at **30%**. Tag \`wholesale30\` added. No further action needed.`
    });
  } catch (e) {
    logger.error('approve_30 failed', e);
    await client.chat.postMessage({ channel, thread_ts, text: `❌ Failed to approve at 30%: ${e.message}` });
  }
});

app.action('approve_25', async ({ ack, body, client, logger }) => {
  await ack(); // fast
  const { channel, thread_ts } = { channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts };
  const { name, customerId } = JSON.parse(body.actions?.[0]?.value || '{}');

  try {
    await addCustomerTags({ numericId: customerId, tags: ['wholesale25'] });
    await client.chat.postMessage({
      channel, thread_ts,
      text: `✅ Approved *${name}* at **25%**. Tag \`wholesale25\` added. No further action needed.`
    });
  } catch (e) {
    logger.error('approve_25 failed', e);
    await client.chat.postMessage({ channel, thread_ts, text: `❌ Failed to approve at 25%: ${e.message}` });
  }
});

app.action('approve_other', async ({ ack, body, client }) => {
  await ack(); // fast
  const base = JSON.parse(body.actions?.[0]?.value || '{}'); // contains { name, customerId }

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'approve_other_modal',
      title: { type: 'plain_text', text: 'Approve (custom %)' },
      submit: { type: 'plain_text', text: 'Apply' },
      close: { type: 'plain_text', text: 'Cancel' },
      private_metadata: JSON.stringify(base),
      blocks: [
        {
          type: 'input',
          block_id: 'pct_block',
          label: { type: 'plain_text', text: 'Enter discount % (1–50)' },
          element: {
            type: 'plain_text_input',
            action_id: 'pct',
            placeholder: { type: 'plain_text', text: 'e.g., 17' }
          }
        }
      ]
    }
  });
});

app.view('approve_other_modal', async ({ ack, view, body, client, logger }) => {
  const meta = JSON.parse(view.private_metadata || '{}');
  const raw = view.state.values?.pct_block?.pct?.value?.trim() || '';
  const pct = Number(raw);

  // Validate
  if (!raw || !Number.isInteger(pct) || pct < 1 || pct > 50) {
    await ack({ response_action: 'errors', errors: { pct_block: 'Please enter an integer between 1 and 50.' } });
    return;
  }

  await ack(); // close modal fast

  const channel = body?.view?.private_metadata ? undefined : undefined; // not used
  const msg = body?.message; // not available here; we will refetch thread via the original message
  // We carry the customer/name only; for posting, reply in the original thread (top-level is fine if user triggers from the thread message)
  // Slack doesn't return the thread here; post a confirmation back to the original channel/thread using interactions payload:
  const container = body?.container || {};
  const thread_ts = container.thread_ts || container.message_ts;
  const channel_id = container.channel_id;

  try {
    await addCustomerTags({ numericId: meta.customerId, tags: [`wholesale${pct}`] });
    if (channel_id) {
      await client.chat.postMessage({
        channel: channel_id,
        thread_ts,
        text: `✅ Approved *${meta.name}* at **${pct}%**. Tag \`wholesale${pct}\` added. No further action needed.`
      });
    }
  } catch (e) {
    logger.error('approve_other failed', e);
    if (channel_id) {
      await client.chat.postMessage({
        channel: channel_id,
        thread_ts,
        text: `❌ Failed to approve at ${pct}%: ${e.message}`
      });
    }
  }
});

app.action('reject', async ({ ack, body, client, logger }) => {
  await ack(); // fast
  const { channel, thread_ts } = { channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts };
  const { name, customerId } = JSON.parse(body.actions?.[0]?.value || '{}');

  try {
    await removeCustomerTags({ numericId: customerId, tags: ['manual-wholesale-customer'] });
    await client.chat.postMessage({
      channel, thread_ts,
      text: `🚫 Rejected *${name}*. Tag \`manual-wholesale-customer\` removed. No further action needed.`
    });
  } catch (e) {
    logger.error('reject failed', e);
    await client.chat.postMessage({ channel, thread_ts, text: `❌ Failed to reject: ${e.message}` });
  }
});

/* =========================
   Optional slash command (test helper)
   /wholesale-approve <CustomerID> | name="Some Name"
========================= */
app.command('/wholesale-approve', async ({ ack, respond, command, client }) => {
  await ack();
  const text = (command.text || '').trim();
  const idMatch = text.match(/(\d{4,})/);
  const nameMatch = text.match(/name=("([^"]+)"|(\S+))/i);
  const customerId = idMatch ? idMatch[1] : '';
  const name = nameMatch ? (nameMatch[2] || nameMatch[3]) : 'Customer';

  if (!customerId) {
    await respond({ text: 'Usage: `/wholesale-approve <CustomerID> name="<Customer Name>"`', response_type: 'ephemeral' });
    return;
  }

  await client.chat.postMessage({
    channel: command.channel_id,
    thread_ts: command.thread_ts || undefined,
    text: `Approve/reject wholesale for ${name} (ID ${customerId}):`,
    blocks: buildButtons({ name, customerId })
  });
});

/* =========================
   Global error logger
========================= */
app.error((error) => {
  console.error('⚠️ Bolt error:', error);
});

/* =========================
   Start
========================= */
(async () => {
  await app.start();
  console.log('✅ wholesale-needs-approval running (Socket Mode)');
  console.log('🔧 Watching channel ID:', WATCH_CHANNEL || '(not set)');
})();
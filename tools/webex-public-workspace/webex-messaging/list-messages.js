import { getWebexUrl, getWebexHeaders } from '../../../lib/webex-config.js';

/**
 * Fetch a single batch of messages from the Webex API.
 * @private
 */
const fetchMessageBatch = async ({ roomId, parentId, mentionedPeople, before, beforeMessage, max, headers }) => {
  const url = new URL(getWebexUrl('/messages'));
  url.searchParams.append('roomId', roomId);
  if (parentId) url.searchParams.append('parentId', parentId);
  if (mentionedPeople) url.searchParams.append('mentionedPeople', mentionedPeople);
  if (before) url.searchParams.append('before', before);
  if (beforeMessage) url.searchParams.append('beforeMessage', beforeMessage);
  url.searchParams.append('max', max.toString());

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(JSON.stringify(errorData));
  }

  return response.json();
};

/**
 * Extract essential fields from a message to reduce response size.
 * @private
 */
const summarizeMessage = (msg) => ({
  id: msg.id,
  personEmail: msg.personEmail,
  personId: msg.personId,
  created: msg.created,
  text: msg.text,
  parentId: msg.parentId,
  roomType: msg.roomType
});

/**
 * Function to list messages in a Webex room.
 *
 * @param {Object} args - Arguments for the message listing.
 * @param {string} args.roomId - The ID of the room to list messages from (required).
 * @param {string} [args.parentId] - The ID of the parent message to filter by.
 * @param {string} [args.mentionedPeople] - List messages with these people mentioned, by ID. Use `me` for the current API user.
 * @param {string} [args.before] - List messages sent before a specific date and time.
 * @param {string} [args.beforeMessage] - List messages sent before a specific message, by ID.
 * @param {string} [args.after] - List messages sent after a specific date and time (ISO 8601 format). Uses client-side filtering with pagination.
 * @param {number} [args.max=50] - Limit the maximum number of messages in the response.
 * @param {boolean} [args.summarize=true] - If true, return only essential fields (id, personEmail, created, text) to reduce response size.
 * @returns {Promise<Object>} - The result of the message listing.
 */
const executeFunction = async ({ roomId, parentId, mentionedPeople, before, beforeMessage, after, max = 50, summarize = true }) => {
  try {
    const headers = await getWebexHeaders();

    // If no 'after' filter, do a simple single fetch
    if (!after) {
      const data = await fetchMessageBatch({
        roomId, parentId, mentionedPeople, before, beforeMessage, max, headers
      });

      if (summarize && data.items) {
        data.items = data.items.map(summarizeMessage);
      }
      return data;
    }

    // With 'after' filter: paginate backward until we pass the target time
    const afterDate = new Date(after);
    if (isNaN(afterDate.getTime())) {
      throw new Error(`Invalid 'after' date format: ${after}. Use ISO 8601 format (e.g., 2024-01-27T18:00:00Z).`);
    }

    const collectedMessages = [];
    let cursor = beforeMessage;
    const batchSize = 100; // Max allowed by API
    const maxIterations = 20; // Safety limit to prevent infinite loops
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      const data = await fetchMessageBatch({
        roomId, parentId, mentionedPeople, before, beforeMessage: cursor, max: batchSize, headers
      });

      if (!data.items || data.items.length === 0) {
        break; // No more messages
      }

      let foundOlderMessage = false;

      for (const msg of data.items) {
        const msgDate = new Date(msg.created);

        if (msgDate >= afterDate) {
          // Message is within our time range
          collectedMessages.push(msg);
        } else {
          // Message is older than our target - stop pagination
          foundOlderMessage = true;
          break;
        }
      }

      if (foundOlderMessage) {
        break; // We've gone past our target time
      }

      // Check if we've hit our max limit
      if (max && collectedMessages.length >= max) {
        collectedMessages.splice(max); // Trim to max
        break;
      }

      // Set cursor for next batch (oldest message ID from current batch)
      cursor = data.items[data.items.length - 1].id;

      // If we got fewer messages than requested, we've reached the end
      if (data.items.length < batchSize) {
        break;
      }
    }

    // Apply max limit if specified
    const limitedMessages = max ? collectedMessages.slice(0, max) : collectedMessages;

    return {
      items: summarize ? limitedMessages.map(summarizeMessage) : limitedMessages,
      count: limitedMessages.length,
      filtered: true,
      afterFilter: after
    };
  } catch (error) {
    console.error('Error listing messages:', error);
    return {
      error: error.message || 'An error occurred while listing messages.',
      details: error.stack
    };
  }
};

/**
 * Tool configuration for listing messages in a Webex room.
 * @type {Object}
 */
const apiTool = {
  function: executeFunction,
  definition: {
    type: 'function',
    function: {
      name: 'list_messages',
      description: 'List messages in a Webex room. Supports filtering by time range using `after` parameter (client-side filtering with automatic pagination). Returns summarized messages by default to reduce response size.',
      parameters: {
        type: 'object',
        properties: {
          roomId: {
            type: 'string',
            description: 'The ID of the room to list messages from.'
          },
          parentId: {
            type: 'string',
            description: 'The ID of the parent message to filter by.'
          },
          mentionedPeople: {
            type: 'string',
            description: 'List messages with these people mentioned, by ID.'
          },
          before: {
            type: 'string',
            description: 'List messages sent before a specific date and time (ISO 8601 format).'
          },
          beforeMessage: {
            type: 'string',
            description: 'List messages sent before a specific message, by ID.'
          },
          after: {
            type: 'string',
            description: 'List messages sent after a specific date and time (ISO 8601 format, e.g., 2024-01-27T18:00:00Z). Uses client-side filtering with automatic pagination to fetch all messages since the specified time.'
          },
          max: {
            type: 'integer',
            description: 'Limit the maximum number of messages in the response. Default is 50.'
          },
          summarize: {
            type: 'boolean',
            description: 'If true (default), return only essential fields (id, personEmail, created, text) to reduce response size. Set to false to get full message objects.'
          }
        },
        required: ['roomId']
      }
    }
  }
};

export { apiTool };
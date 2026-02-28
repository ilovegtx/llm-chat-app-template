/**
 * LLM Chat App Frontend
 *
 * Handles the chat UI interactions and communication with the backend API.
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

// Chat state
let chatHistory = [
	{
		role: "assistant",
		content:
			"Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
	},
];
let isProcessing = false;

/**
 * Creates and appends an assistant message element to the chat.
 * Returns the inner <p> element so the caller can update its contents.
 */
function createAssistantMessageElement() {
	const assistantMessageEl = document.createElement("div");
	assistantMessageEl.className = "message assistant-message";
	const assistantTextEl = document.createElement("p");
	assistantMessageEl.appendChild(assistantTextEl);
	chatMessages.appendChild(assistantMessageEl);
	return assistantTextEl;
}

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
	this.style.height = "auto";
	this.style.height = this.scrollHeight + "px";
});

// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

// Send button click handler
sendButton.addEventListener("click", sendMessage);

/**
 * Sends a message to the chat API and processes the response
 */
async function sendMessage() {
	const message = userInput.value.trim();

	// Don't send empty messages
	if (message === "" || isProcessing) return;

	// Disable input while processing
	isProcessing = true;
	userInput.disabled = true;
	sendButton.disabled = true;

	// Add user message to chat
	addMessageToChat("user", message);

	// Clear input
	userInput.value = "";
	userInput.style.height = "auto";

	// Show typing indicator
	typingIndicator.classList.add("visible");

	// Add message to history
	chatHistory.push({ role: "user", content: message });

	try {
		// Create new assistant response element
		const assistantTextEl = createAssistantMessageElement();

		// Scroll to bottom
		chatMessages.scrollTop = chatMessages.scrollHeight;

		// Send request to API
		const response = await fetch("/api/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messages: chatHistory,
			}),
		});

		// Handle errors
		if (!response.ok) {
			throw new Error(
				`API request to /api/chat failed with status ${response.status}: ${response.statusText}. Please try again or check your connection.`,
			);
		}
		if (!response.body) {
			throw new Error("Response body is null");
		}

		// Process streaming response
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let responseText = "";
		let buffer = "";

		const flushAssistantText = () => {
			assistantTextEl.textContent = responseText;
			chatMessages.scrollTop = chatMessages.scrollHeight;
		};

		// Read streaming SSE response
		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				// Process any remaining events by synthetically appending the SSE record terminator.
				// SSE events are separated by a blank line; if the stream ends without one,
				// adding "\n\n" ensures the final event is flushed and parsed correctly.
				const parsed = consumeSseEvents(buffer + "\n\n");
				for (const data of parsed.events) {
					if (data === "[DONE]") break;
					responseText = processSseDataChunk(
						data,
						responseText,
						flushAssistantText,
					);
				}
				break;
			}

			// Append new chunk to buffer
			buffer += decoder.decode(value, { stream: true });

			// Process complete events from buffer
			const parsed = consumeSseEvents(buffer);
			buffer = parsed.buffer;

			for (const data of parsed.events) {
				if (data === "[DONE]") break;
				responseText = processSseDataChunk(
					data,
					responseText,
					flushAssistantText,
				);
			}
		}

		// Add final response to chat history
		chatHistory.push({ role: "assistant", content: responseText });

	} catch (error) {
		console.error("Error:", error);
		const errorMessage = error && error.message ? error.message : String(error);
		addMessageToChat(
			"assistant",
			`Sorry, there was an error processing your request: ${errorMessage}`,
		);
	} finally {
		// Hide typing indicator
		typingIndicator.classList.remove("visible");

		// Re-enable input
		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
		userInput.focus();
	}
}

/**
 * Helper function to add message to chat
 */
function addMessageToChat(role, content) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;
	const paragraphEl = document.createElement("p");
	paragraphEl.textContent = content;
	messageEl.appendChild(paragraphEl);
	chatMessages.appendChild(messageEl);

	// Scroll to bottom
	chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Parses SSE events from a buffer string.
 * 
 * @param {string} buffer - The buffer containing SSE data.
 * @returns {Object} Object with `events` array and remaining `buffer`.
 */
function consumeSseEvents(buffer) {
	let normalized = buffer.replace(/\r/g, "");
	const events = [];
	let eventEndIndex;

	while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
		const rawEvent = normalized.slice(0, eventEndIndex);
		normalized = normalized.slice(eventEndIndex + 2);

		const lines = rawEvent.split("\n");
		const dataLines = [];

		for (const line of lines) {
			if (line.startsWith("data:")) {
				dataLines.push(line.slice("data:".length).trimStart());
			}
		}

		if (dataLines.length === 0) continue;
		events.push(dataLines.join("\n"));
	}

	return { events, buffer: normalized };
}

/**
 * Helper to parse a single SSE data chunk and update the response text.
 *
 * Handles both Workers AI format (`response`) and OpenAI-style streaming
 * format (`choices[0].delta.content`).
 *
 * @param {string} data - Raw SSE data line (without "data:" prefix).
 * @param {string} responseText - Current accumulated response text.
 * @param {Function} flushAssistantText - Callback to update the UI.
 * @returns {string} Updated response text.
 */
function processSseDataChunk(data, responseText, flushAssistantText) {
	// Skip [DONE] marker
	if (data === "[DONE]") {
		return responseText;
	}

	try {
		const jsonData = JSON.parse(data);
		let content = "";

		// Handle Workers AI format (response)
		if (typeof jsonData.response === "string" && jsonData.response.length > 0) {
			content = jsonData.response;
		} 
		// Handle OpenAI format (choices[0].delta.content)
		else if (jsonData.choices?.[0]?.delta?.content) {
			content = jsonData.choices[0].delta.content;
		}

		// Append content and update UI
		if (content) {
			responseText += content;
			flushAssistantText();
		}
	} catch (error) {
		console.error("Failed to parse SSE data:", error, data);
	}

	return responseText;
}

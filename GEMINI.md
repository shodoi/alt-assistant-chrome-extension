# Project Overview

This is a Chrome extension that allows users to generate alt text for images using the Google Gemini API. Users can right-click on an image, provide a prompt, and the extension will generate alt text based on the image content and the user's instructions.

The extension has three main components:

*   **Background Script (`background.js`)**: Handles the communication with the Gemini API, manages the context menu, and orchestrates the overall process.
*   **Content Script (`content.js`)**: Injects UI elements into the active web page, including dialogs for user input and for displaying the generated alt text.
*   **Options Page (`options.html`, `options.js`)**: Allows the user to configure their Gemini API key.

# Building and Running

This is a browser extension and does not have a build process. To run this extension:

1.  Open Google Chrome and navigate to `chrome://extensions`.
2.  Enable "Developer mode" using the toggle switch in the top right corner.
3.  Click the "Load unpacked" button.
4.  Select the directory containing this project.

The extension will be installed and ready to use.

To acquire a Gemini API key, visit https://aistudio.google.com/ and create a new API key. Once you have the key, open the extension's options page and paste the key into the input field.

# Development Conventions

*   The extension uses the `chrome.storage.sync` API to store the user's API key.
*   Communication between the background and content scripts is done using `chrome.runtime.sendMessage` and `chrome.runtime.onMessage`.
*   The user interface is created dynamically using JavaScript and injected into the web page.
*   The Gemini API is called from the background script to avoid exposing the API key in the content script.
*   The code is written in JavaScript with JSDoc comments.

# AI Instructions

- **Critical Requirement (Top Priority)**: `walkthrough.md` MUST be written entirely in Japanese. Writing this file in English is strictly prohibited.

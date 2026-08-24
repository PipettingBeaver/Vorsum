# Vorsum - ∑ YouTube summary userscript

Vorsum is a summarizer for YouTube that I made since I couldn't find any sleek in-line YouTube summarizers that were quite what I wanted.
My utility uses free Gemini and YouTube API to make calls for videos for URL-based parsing or captions respectively, and has a built-in tutorial for beginners.

Here are examples showing the base YouTube layout on light mode alongside compatibility with the Vorapis UI layout on dark mode:

<table>
  <tr>
    <td align="center">
      <img width="400" alt="Base YouTube layout on light mode" src="https://github.com/user-attachments/assets/1150f3b2-32a2-417c-ab58-a0b1adbfd2a4" />
      <br />
      <sub><b>Light Mode (Base YouTube)</b></sub>
    </td>
    <td align="center">
      <img width="400" alt="Vorapis UI layout on dark mode" src="https://github.com/user-attachments/assets/b234ec7e-30cd-4be0-9b1b-dc8098ee79d8" />
      <br />
      <sub><b>Dark Mode (Vorapis UI)</b></sub>
    </td>
  </tr>
</table>

# Installation as Userscript
All you need is ViolentMonkey or an equivalent Userscript Manager, paste in the URL for this open-source userscript, and you're good to go.
1. Depending on what browser you prefer to use, ViolentMonkey can be found below:
   
a. [https://addons.mozilla.org/en-US/firefox/addon/violentmonkey/](https://addons.mozilla.org/en-US/firefox/addon/violentmonkey/)

b. [https://chromewebstore.google.com/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag](https://chromewebstore.google.com/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag)

2. After installation, open the extension and click the gear symbol (⚙) in the menu. This goes to the Userscripts page.
<img width="330" height="217" alt="RdBUQPzZ5h" src="https://github.com/user-attachments/assets/d53c5212-2249-4060-b184-bf5b23d5f9ca" />

3. Navigate to the top left of this page and click "New" and then "New from URL".
<img width="443" height="357" alt="firefox_MDecftEzOp" src="https://github.com/user-attachments/assets/f0221cea-246f-4338-a588-34c9102fdf0a" />

Copy and paste the vorsum userscript URL below, hosted on this github repo:

```js
https://raw.githubusercontent.com/PipettingBeaver/Vorsum/refs/heads/main/Vorsum_Userscript.js
```

4. There is a quick onboarding for first-time initialization for getting set up, or you can follow the beginner setup guide included below.

# Quick user setup guide
a. Make sure you're logged in to your Google account and navigate to [https://aistudio.google.com/api-keys](https://aistudio.google.com/api-keys).

b. Click "Create API Key" and copy the unique code generated. Navigate back to YouTube.

c. Navigate to the top left and expand the Options menu:

<img width="319" height="319" alt="image" src="https://github.com/user-attachments/assets/15e5b841-c54d-4254-bcd4-4543b50c4f7e" />

d. Make sure Gemini is selected.

e. Paste your API key from earlier.


Vorapis UI, mentioned above, is not affiliated with my project, even though I've made my work compatible. You can get it here: [https://vorapis.pages.dev/](https://vorapis.pages.dev/)


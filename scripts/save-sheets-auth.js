// Run once to save Google Sheets OAuth token
const { OAuth2Client } = require('google-auth-library');
const http = require('http');
const url = require('url');
const fs = require('fs');
const { exec } = require('child_process');

const CREDS_FILE = 'credentials.json';
const TOKEN_FILE = 'sheets-token.json';
const PORT = 3000;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

(async () => {
  if (!fs.existsSync(CREDS_FILE)) {
    console.error('credentials.json not found. See README for setup steps.');
    process.exit(1);
  }

  const { client_id, client_secret } = JSON.parse(fs.readFileSync(CREDS_FILE)).installed;
  const client = new OAuth2Client(client_id, client_secret, REDIRECT);

  const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });

  const code = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const { code } = url.parse(req.url, true).query;
      if (code) {
        res.end('<h2>Auth complete! You can close this tab.</h2>');
        server.close();
        resolve(code);
      }
    });
    server.listen(PORT, () => {
      console.log('Opening browser for Google auth...');
      exec(`open "${authUrl}"`);
    });
  });

  const { tokens } = await client.getToken(code);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  console.log('Saved to sheets-token.json');
  process.exit(0);
})();

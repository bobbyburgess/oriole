// Headless test for Oriole viewer
const puppeteer = require('puppeteer');

async function testViewer() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  // Capture console logs
  page.on('console', msg => {
    console.log('BROWSER CONSOLE:', msg.type(), msg.text());
  });

  // Capture network requests
  page.on('requestfailed', request => {
    console.log('REQUEST FAILED:', request.url(), request.failure().errorText);
  });

  page.on('response', async response => {
    const url = response.url();
    if (url.includes('experiments')) {
      console.log('EXPERIMENT API RESPONSE:', response.status(), url);
      try {
        const text = await response.text();
        console.log('RESPONSE BODY:', text);
      } catch (e) {
        console.log('Could not read response body:', e.message);
      }
    }
  });

  try {
    console.log('Navigating to viewer...');
    await page.goto('https://zzdpv8qk90.execute-api.us-west-2.amazonaws.com/viewer', {
      waitUntil: 'networkidle2'
    });

    console.log('Page loaded, checking for login form...');
    await page.waitForSelector('#username', { timeout: 5000 });

    console.log('Entering credentials...');
    await page.type('#username', 'bobby');
    await page.type('#password', 'your-password-here'); // Replace with actual password

    console.log('Clicking sign in...');
    await page.click('button[onclick="login()"]');

    // Wait for login to complete
    await page.waitForTimeout(2000);

    // Check if viewer content is visible
    const viewerVisible = await page.evaluate(() => {
      const viewerContent = document.getElementById('viewer-content');
      return viewerContent && viewerContent.style.display !== 'none';
    });

    console.log('Viewer content visible:', viewerVisible);

    if (viewerVisible) {
      console.log('Login successful! Trying to load experiment...');

      // Set experiment ID to 10
      await page.evaluate(() => {
        document.getElementById('experimentId').value = '10';
      });

      console.log('Clicking Load Experiment...');
      await page.click('button[onclick="loadExperiment()"]');

      // Wait for response
      await page.waitForTimeout(3000);

      // Check experiment info
      const experimentInfo = await page.evaluate(() => {
        return document.getElementById('experimentInfo').innerHTML;
      });

      console.log('Experiment Info:', experimentInfo);

      // Take screenshot
      await page.screenshot({ path: '/tmp/viewer-screenshot.png' });
      console.log('Screenshot saved to /tmp/viewer-screenshot.png');
    } else {
      console.log('Login failed or viewer not visible');
      const loginError = await page.evaluate(() => {
        return document.getElementById('login-error').textContent;
      });
      console.log('Login error:', loginError);
    }

  } catch (error) {
    console.error('Test error:', error.message);
    await page.screenshot({ path: '/tmp/viewer-error.png' });
    console.log('Error screenshot saved to /tmp/viewer-error.png');
  } finally {
    await browser.close();
  }
}

testViewer().catch(console.error);

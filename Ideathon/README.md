# Live ship map setup

The map uses AISStream for live AIS positions. AISStream offers a free API key, but it must be kept on the server. The local backend proxies only the current map area's ship positions to the browser.

1. Create an AISStream account and API key at <https://aisstream.io/account>.
2. Install the Python dependency from this folder:

   ```powershell
   py -m pip install -r requirements.txt
   ```

3. In PowerShell, enter the key securely and start the local server:

   ```powershell
   $secureKey = Read-Host "AISStream API key" -AsSecureString
   $env:AISSTREAM_API_KEY = [System.Net.NetworkCredential]::new("", $secureKey).Password
   py server.py
   ```

4. Open <http://127.0.0.1:8000/map.html>. Keep the terminal running while using the map. Stop the server with Ctrl+C, then clear the key from that PowerShell session:

   ```powershell
   Remove-Item Env:AISSTREAM_API_KEY
   Remove-Variable secureKey
   ```

The live feed follows the current map area. Click a ship marker to see its name, MMSI, speed, course, and last AIS report time. AIS updates depend on receiver coverage and are not guaranteed to be continuous.

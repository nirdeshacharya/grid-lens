# Grid Lens

A map-based explorer of the Scottish and Southern Electricity Networks (SSEN) distribution area, built on open data.

- **Capacity** – estimated demand and generation headroom at every grid supply point, bulk supply point and primary substation, with a postcode search.
- **Outages** – SSEN's hourly outage feed, with place names and current wind gusts.
- **Generation** – sites of 1 MW and above on the Embedded Capacity Register.
- **Faults** – high-voltage fault records since 2015, by cause and by primary substation.
- **Flexibility** – this week's day-ahead flexibility tenders, by zone and service window.
- **Carbon** – regional carbon intensity now and for the next 48 hours.

It is a static site: three files, no build step and no server. Every figure is fetched in the visitor's browser when the page loads.

## Data sources

- [SSEN Distribution open data portal](https://data.ssen.co.uk)
- [NESO Carbon Intensity API](https://carbonintensity.org.uk)
- [Open-Meteo](https://open-meteo.com) for wind gusts
- [postcodes.io](https://postcodes.io) for postcode and place lookup
- Map tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors

Headroom, volumes and budgets are indicative figures published by SSEN and are not a substitute for a connection application. This project is not affiliated with SSEN.

## Run locally

```bash
python3 -m http.server 5178
```

Then open http://localhost:5178.

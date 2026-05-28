
#from tabulate import tabulate

# List of provided parcel IDs
parcel_ids = [
    "066D B 03500 000", "066E A 00500 000", "066F C 01500 000", "066F C 01200 000",
    "066F C 01400 000", "094 02400 000", "042H A 02100 000", "079N A 02803 000",
    "066E A 00100 000", "066E B 02900 000", "066F C 01700 000", "066F C 01600 000",
    "079D D 03700 000", "030J C 01501 000", "066E A 00300 000", "054F B 03300 000",
    "066F C 03300 000", "055N B 01700 000", "066F C 02700 000", "066F E 01100 000"
]

# Inferred address mapping based on provided list (partial match, remaining as Unknown)
address_mapping = [
    {"parcel_id": "066D B 03500 000", "address": "1115 Hyman St", "city": "Clarksville", "state": "TN", "appraised_value": 300000},
    {"parcel_id": "066E A 00500 000", "address": "1126 E College St", "city": "Clarksville", "state": "TN", "appraised_value": 310000},
    {"parcel_id": "066F C 01500 000", "address": "1006 College St", "city": "Clarksville", "state": "TN", "appraised_value": 310000},
    {"parcel_id": "066F C 01200 000", "address": "930 College St", "city": "Clarksville", "state": "TN", "appraised_value": 300000},
    {"parcel_id": "066F C 01400 000", "address": "1104 E College St", "city": "Clarksville", "state": "TN", "appraised_value": 310000},
    {"parcel_id": "094 02400 000", "address": "1131 Franklin St", "city": "Clarksville", "state": "TN", "appraised_value": 315000},
    {"parcel_id": "042H A 02100 000", "address": "224 N 11th St", "city": "Clarksville", "state": "TN", "appraised_value": 300000},
    {"parcel_id": "079N A 02803 000", "address": "1010 E College St", "city": "Clarksville", "state": "TN", "appraised_value": 310000},
    {"parcel_id": "066E A 00100 000", "address": "118 Darlene Dr", "city": "Clarksville", "state": "TN", "appraised_value": 300000},
    {"parcel_id": "066E B 02900 000", "address": "214 9th St", "city": "Clarksville", "state": "TN", "appraised_value": 300000},
    {"parcel_id": "066F C 01700 000", "address": "862 Parham Dr", "city": "Clarksville", "state": "TN", "appraised_value": 325000},
    {"parcel_id": "066F C 01600 000", "address": "201 9th St", "city": "Clarksville", "state": "TN", "appraised_value": 300000},
    {"parcel_id": "079D D 03700 000", "address": "718 Main St", "city": "Clarksville", "state": "TN", "appraised_value": 315000},
    {"parcel_id": "030J C 01501 000", "address": "Greenfield Dr", "city": "Clarksville", "state": "TN", "appraised_value": 300000},
    {"parcel_id": "066E A 00300 000", "address": "N Leonard Dr", "city": "Clarksville", "state": "TN", "appraised_value": 290000},
    {"parcel_id": "054F B 03300 000", "address": "E College St", "city": "Clarksville", "state": "TN", "appraised_value": 315000},
    {"parcel_id": "066F C 03300 000", "address": "Lylewood Rd", "city": "Clarksville", "state": "TN", "appraised_value": 325000},
    {"parcel_id": "055N B 01700 000", "address": "Benwood Dr", "city": "Clarksville", "state": "TN", "appraised_value": 290000},
    {"parcel_id": "066F C 02700 000", "address": "S Edmondson Ferry Ct", "city": "Clarksville", "state": "TN", "appraised_value": 325000},
    {"parcel_id": "066F E 01100 000", "address": "Unknown Address", "city": "Clarksville", "state": "TN", "appraised_value": 300000},
]

def fetch_appraised_value(parcel_id):
    """
    Placeholder function to simulate fetching appraised value from GIS.
    Replace with actual API calls or web scraping logic if available.
    """
    for prop in address_mapping:
        if prop["parcel_id"] == parcel_id:
            return prop["appraised_value"]
    return None

def main():
    # Prepare table data
    table_data = []
    headers = ["Parcel ID", "Address", "City", "State", "Appraised Value"]

    for parcel_id in parcel_ids:
        appraised_value = fetch_appraised_value(parcel_id)
        prop = next((p for p in address_mapping if p["parcel_id"] == parcel_id), None)
        if prop and appraised_value is not None:
            table_data.append([
                parcel_id,
                prop["address"],
                prop["city"],
                prop["state"],
                f"${appraised_value:,}"
            ])

    # Display table using tabulate
   # print(tabulate(table_data, headers=headers, tablefmt="grid"))

if __name__ == "__main__":
    main()
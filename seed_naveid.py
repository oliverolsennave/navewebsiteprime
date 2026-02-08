#!/usr/bin/env python3
"""
Seed the NaveIDPriests collection in Firestore using the REST API.
Uses the same approach as check_and_add_parish_ownership.py.
"""

import requests
import json
from datetime import datetime

# Firebase configuration (same as other Nave scripts)
PROJECT_ID = "navefirebase"
API_KEY = "AIzaSyDMzrI35yZxIlUr-OJ56acE_bMnYnrHoEw"
FIREBASE_REST_BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents"

EMAIL = "olsenoliver5@gmail.com"

def main():
    print(f"Creating NaveIDPriests/{EMAIL}...")

    doc_url = f"{FIREBASE_REST_BASE}/NaveIDPriests/{EMAIL}"
    
    document = {
        "fields": {
            "email": {"stringValue": EMAIL},
            "displayName": {"stringValue": "Oliver Olsen"},
            "diocese": {"stringValue": "Diocese of Philadelphia"},
            "status": {"stringValue": "active"},
            "createdAt": {
                "timestampValue": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
            },
        }
    }

    # PATCH creates or updates the document
    response = requests.patch(doc_url, json=document)

    if response.status_code == 200:
        result = response.json()
        print(f"✅ Document created: {result.get('name', 'unknown')}")
        print(f"   Email:   {EMAIL}")
        print(f"   Status:  active")
        print(f"   Diocese: Diocese of Philadelphia")
        print(f"\n🎉 Done! NaveID will now show for this account in iOS Settings.")
    else:
        print(f"❌ Error {response.status_code}: {response.text}")
        if response.status_code == 403:
            print("\nFirestore rules may be blocking writes to NaveIDPriests.")
            print("Add this rule in Firebase Console > Firestore > Rules:")
            print('  match /NaveIDPriests/{doc} { allow read, write: if true; }')

if __name__ == "__main__":
    main()

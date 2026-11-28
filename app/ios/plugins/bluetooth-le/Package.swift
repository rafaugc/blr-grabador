// swift-tools-version: 5.9
import PackageDescription

// Copia de @capacitor-community/bluetooth-le 8.4.0 (licencia MIT, ver LICENSE), sin el apartado de pruebas.
let package = Package(
    name: "CapacitorCommunityBluetoothLe",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapacitorCommunityBluetoothLe",
            targets: ["BluetoothLe"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "BluetoothLe",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/BluetoothLe")
    ]
)

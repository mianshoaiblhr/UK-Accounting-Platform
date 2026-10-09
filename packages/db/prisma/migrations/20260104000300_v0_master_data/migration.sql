-- V0 Tranche A: core master data (specification section 3): contacts, addresses, directors/officers, currencies, countries,
-- tax jurisdictions, financial year-end and the company profile. Additive only.
--   * REFERENCE tables (currency, country, tax_jurisdiction) are global and read-only for the runtime role.
--   * Tenant tables (contact, address, company_officer) follow the standard model: organisation_id, composite FKs, forced RLS.

CREATE TYPE "ContactKind" AS ENUM ('PERSON', 'ORGANISATION');
CREATE TYPE "ContactStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "AddressKind" AS ENUM ('REGISTERED_OFFICE', 'TRADING', 'CORRESPONDENCE', 'RESIDENTIAL', 'OTHER');
CREATE TYPE "OfficerRole" AS ENUM ('DIRECTOR', 'SECRETARY', 'PERSON_WITH_SIGNIFICANT_CONTROL', 'MEMBER', 'PARTNER', 'TRUSTEE', 'OTHER');

-- ───────── Reference data (global, read-only) ─────────
CREATE TABLE "currency" (
    "code" CHAR(3) NOT NULL,
    "numeric_code" CHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "minor_units" SMALLINT NOT NULL,
    CONSTRAINT "currency_pkey" PRIMARY KEY ("code"),
    CONSTRAINT currency_code_ck CHECK (code ~ '^[A-Z]{3}$'),
    CONSTRAINT currency_minor_units_ck CHECK (minor_units BETWEEN 0 AND 4)
);
CREATE UNIQUE INDEX "currency_numeric_code_key" ON "currency"("numeric_code");

CREATE TABLE "country" (
    "alpha2" CHAR(2) NOT NULL,
    "alpha3" CHAR(3) NOT NULL,
    "numeric_code" CHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    CONSTRAINT "country_pkey" PRIMARY KEY ("alpha2"),
    CONSTRAINT country_alpha2_ck CHECK (alpha2 ~ '^[A-Z]{2}$')
);
CREATE UNIQUE INDEX "country_alpha3_key" ON "country"("alpha3");
CREATE UNIQUE INDEX "country_numeric_code_key" ON "country"("numeric_code");

-- Tax jurisdictions are EFFECTIVE-DATED (Manifest control 9): the same code may be redefined over time, never overlapping.
CREATE TABLE "tax_jurisdiction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "name" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    CONSTRAINT "tax_jurisdiction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT tax_jurisdiction_code_ck CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,30}$'),
    CONSTRAINT tax_jurisdiction_dates_ck CHECK (valid_to IS NULL OR valid_to > valid_from)
);
ALTER TABLE "tax_jurisdiction" ADD CONSTRAINT "tax_jurisdiction_country_code_fkey" FOREIGN KEY ("country_code") REFERENCES "country"("alpha2") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tax_jurisdiction" ADD CONSTRAINT tax_jurisdiction_no_overlap
  EXCLUDE USING gist (code WITH =, daterange(valid_from, valid_to, '[)') WITH &&);
CREATE INDEX "tax_jurisdiction_country_code_idx" ON "tax_jurisdiction"("country_code");

-- ISO 4217 (funds, precious metals and test codes excluded). Source: iso-codes 4217; minor units from ICU.
INSERT INTO currency (code, numeric_code, name, minor_units) VALUES
('AED', '784', 'UAE Dirham', 2),
('AFN', '971', 'Afghani', 0),
('ALL', '008', 'Lek', 0),
('AMD', '051', 'Armenian Dram', 2),
('ANG', '532', 'Netherlands Antillean Guilder', 2),
('AOA', '973', 'Kwanza', 2),
('ARS', '032', 'Argentine Peso', 2),
('AUD', '036', 'Australian Dollar', 2),
('AWG', '533', 'Aruban Florin', 2),
('AZN', '944', 'Azerbaijan Manat', 2),
('BAM', '977', 'Convertible Mark', 2),
('BBD', '052', 'Barbados Dollar', 2),
('BDT', '050', 'Taka', 2),
('BGN', '975', 'Bulgarian Lev', 2),
('BHD', '048', 'Bahraini Dinar', 3),
('BIF', '108', 'Burundi Franc', 0),
('BMD', '060', 'Bermudian Dollar', 2),
('BND', '096', 'Brunei Dollar', 2),
('BOB', '068', 'Boliviano', 2),
('BRL', '986', 'Brazilian Real', 2),
('BSD', '044', 'Bahamian Dollar', 2),
('BTN', '064', 'Ngultrum', 2),
('BWP', '072', 'Pula', 2),
('BYN', '933', 'Belarusian Ruble', 2),
('BZD', '084', 'Belize Dollar', 2),
('CAD', '124', 'Canadian Dollar', 2),
('CDF', '976', 'Congolese Franc', 2),
('CHF', '756', 'Swiss Franc', 2),
('CLP', '152', 'Chilean Peso', 0),
('CNY', '156', 'Yuan Renminbi', 2),
('COP', '170', 'Colombian Peso', 2),
('CRC', '188', 'Costa Rican Colon', 2),
('CUC', '931', 'Peso Convertible', 2),
('CUP', '192', 'Cuban Peso', 2),
('CVE', '132', 'Cabo Verde Escudo', 2),
('CZK', '203', 'Czech Koruna', 2),
('DJF', '262', 'Djibouti Franc', 0),
('DKK', '208', 'Danish Krone', 2),
('DOP', '214', 'Dominican Peso', 2),
('DZD', '012', 'Algerian Dinar', 2),
('EGP', '818', 'Egyptian Pound', 2),
('ERN', '232', 'Nakfa', 2),
('ETB', '230', 'Ethiopian Birr', 2),
('EUR', '978', 'Euro', 2),
('FJD', '242', 'Fiji Dollar', 2),
('FKP', '238', 'Falkland Islands Pound', 2),
('GBP', '826', 'Pound Sterling', 2),
('GEL', '981', 'Lari', 2),
('GHS', '936', 'Ghana Cedi', 2),
('GIP', '292', 'Gibraltar Pound', 2),
('GMD', '270', 'Dalasi', 2),
('GNF', '324', 'Guinean Franc', 0),
('GTQ', '320', 'Quetzal', 2),
('GYD', '328', 'Guyana Dollar', 2),
('HKD', '344', 'Hong Kong Dollar', 2),
('HNL', '340', 'Lempira', 2),
('HRK', '191', 'Kuna', 2),
('HTG', '332', 'Gourde', 2),
('HUF', '348', 'Forint', 2),
('IDR', '360', 'Rupiah', 2),
('ILS', '376', 'New Israeli Sheqel', 2),
('INR', '356', 'Indian Rupee', 2),
('IQD', '368', 'Iraqi Dinar', 0),
('IRR', '364', 'Iranian Rial', 0),
('ISK', '352', 'Iceland Krona', 0),
('JMD', '388', 'Jamaican Dollar', 2),
('JOD', '400', 'Jordanian Dinar', 3),
('JPY', '392', 'Yen', 0),
('KES', '404', 'Kenyan Shilling', 2),
('KGS', '417', 'Som', 2),
('KHR', '116', 'Riel', 2),
('KMF', '174', 'Comorian Franc', 0),
('KPW', '408', 'North Korean Won', 0),
('KRW', '410', 'Won', 0),
('KWD', '414', 'Kuwaiti Dinar', 3),
('KYD', '136', 'Cayman Islands Dollar', 2),
('KZT', '398', 'Tenge', 2),
('LAK', '418', 'Lao Kip', 0),
('LBP', '422', 'Lebanese Pound', 0),
('LKR', '144', 'Sri Lanka Rupee', 2),
('LRD', '430', 'Liberian Dollar', 2),
('LSL', '426', 'Loti', 2),
('LYD', '434', 'Libyan Dinar', 3),
('MAD', '504', 'Moroccan Dirham', 2),
('MDL', '498', 'Moldovan Leu', 2),
('MGA', '969', 'Malagasy Ariary', 0),
('MKD', '807', 'Denar', 2),
('MMK', '104', 'Kyat', 0),
('MNT', '496', 'Tugrik', 2),
('MOP', '446', 'Pataca', 2),
('MRU', '929', 'Ouguiya', 2),
('MUR', '480', 'Mauritius Rupee', 2),
('MVR', '462', 'Rufiyaa', 2),
('MWK', '454', 'Malawi Kwacha', 2),
('MXN', '484', 'Mexican Peso', 2),
('MYR', '458', 'Malaysian Ringgit', 2),
('MZN', '943', 'Mozambique Metical', 2),
('NAD', '516', 'Namibia Dollar', 2),
('NGN', '566', 'Naira', 2),
('NIO', '558', 'Cordoba Oro', 2),
('NOK', '578', 'Norwegian Krone', 2),
('NPR', '524', 'Nepalese Rupee', 2),
('NZD', '554', 'New Zealand Dollar', 2),
('OMR', '512', 'Rial Omani', 3),
('PAB', '590', 'Balboa', 2),
('PEN', '604', 'Sol', 2),
('PGK', '598', 'Kina', 2),
('PHP', '608', 'Philippine Peso', 2),
('PKR', '586', 'Pakistan Rupee', 2),
('PLN', '985', 'Zloty', 2),
('PYG', '600', 'Guarani', 0),
('QAR', '634', 'Qatari Rial', 2),
('RON', '946', 'Romanian Leu', 2),
('RSD', '941', 'Serbian Dinar', 0),
('RUB', '643', 'Russian Ruble', 2),
('RWF', '646', 'Rwanda Franc', 0),
('SAR', '682', 'Saudi Riyal', 2),
('SBD', '090', 'Solomon Islands Dollar', 2),
('SCR', '690', 'Seychelles Rupee', 2),
('SDG', '938', 'Sudanese Pound', 2),
('SEK', '752', 'Swedish Krona', 2),
('SGD', '702', 'Singapore Dollar', 2),
('SHP', '654', 'Saint Helena Pound', 2),
('SLE', '925', 'Leone', 2),
('SLL', '694', 'Leone', 0),
('SOS', '706', 'Somali Shilling', 0),
('SRD', '968', 'Surinam Dollar', 2),
('SSP', '728', 'South Sudanese Pound', 2),
('STN', '930', 'Dobra', 2),
('SVC', '222', 'El Salvador Colon', 2),
('SYP', '760', 'Syrian Pound', 0),
('SZL', '748', 'Lilangeni', 2),
('THB', '764', 'Baht', 2),
('TJS', '972', 'Somoni', 2),
('TMT', '934', 'Turkmenistan New Manat', 2),
('TND', '788', 'Tunisian Dinar', 3),
('TOP', '776', 'Pa’anga', 2),
('TRY', '949', 'Turkish Lira', 2),
('TTD', '780', 'Trinidad and Tobago Dollar', 2),
('TWD', '901', 'New Taiwan Dollar', 2),
('TZS', '834', 'Tanzanian Shilling', 2),
('UAH', '980', 'Hryvnia', 2),
('UGX', '800', 'Uganda Shilling', 0),
('USD', '840', 'US Dollar', 2),
('UYU', '858', 'Peso Uruguayo', 2),
('UZS', '860', 'Uzbekistan Sum', 2),
('VED', '926', 'Bolívar Soberano', 2),
('VES', '928', 'Bolívar Soberano', 2),
('VND', '704', 'Dong', 0),
('VUV', '548', 'Vatu', 0),
('WST', '882', 'Tala', 2),
('XAF', '950', 'CFA Franc BEAC', 0),
('XCD', '951', 'East Caribbean Dollar', 2),
('XOF', '952', 'CFA Franc BCEAO', 0),
('XPF', '953', 'CFP Franc', 0),
('YER', '886', 'Yemeni Rial', 0),
('ZAR', '710', 'Rand', 2),
('ZMW', '967', 'Zambian Kwacha', 2),
('ZWL', '932', 'Zimbabwe Dollar', 2);

-- ISO 3166-1 (249 officially assigned codes). Source: iso-codes 3166-1.
INSERT INTO country (alpha2, alpha3, numeric_code, name) VALUES
('AW', 'ABW', '533', 'Aruba'),
('AF', 'AFG', '004', 'Afghanistan'),
('AO', 'AGO', '024', 'Angola'),
('AI', 'AIA', '660', 'Anguilla'),
('AX', 'ALA', '248', 'Åland Islands'),
('AL', 'ALB', '008', 'Albania'),
('AD', 'AND', '020', 'Andorra'),
('AE', 'ARE', '784', 'United Arab Emirates'),
('AR', 'ARG', '032', 'Argentina'),
('AM', 'ARM', '051', 'Armenia'),
('AS', 'ASM', '016', 'American Samoa'),
('AQ', 'ATA', '010', 'Antarctica'),
('TF', 'ATF', '260', 'French Southern Territories'),
('AG', 'ATG', '028', 'Antigua and Barbuda'),
('AU', 'AUS', '036', 'Australia'),
('AT', 'AUT', '040', 'Austria'),
('AZ', 'AZE', '031', 'Azerbaijan'),
('BI', 'BDI', '108', 'Burundi'),
('BE', 'BEL', '056', 'Belgium'),
('BJ', 'BEN', '204', 'Benin'),
('BQ', 'BES', '535', 'Bonaire, Sint Eustatius and Saba'),
('BF', 'BFA', '854', 'Burkina Faso'),
('BD', 'BGD', '050', 'Bangladesh'),
('BG', 'BGR', '100', 'Bulgaria'),
('BH', 'BHR', '048', 'Bahrain'),
('BS', 'BHS', '044', 'Bahamas'),
('BA', 'BIH', '070', 'Bosnia and Herzegovina'),
('BL', 'BLM', '652', 'Saint Barthélemy'),
('BY', 'BLR', '112', 'Belarus'),
('BZ', 'BLZ', '084', 'Belize'),
('BM', 'BMU', '060', 'Bermuda'),
('BO', 'BOL', '068', 'Bolivia'),
('BR', 'BRA', '076', 'Brazil'),
('BB', 'BRB', '052', 'Barbados'),
('BN', 'BRN', '096', 'Brunei Darussalam'),
('BT', 'BTN', '064', 'Bhutan'),
('BV', 'BVT', '074', 'Bouvet Island'),
('BW', 'BWA', '072', 'Botswana'),
('CF', 'CAF', '140', 'Central African Republic'),
('CA', 'CAN', '124', 'Canada'),
('CC', 'CCK', '166', 'Cocos (Keeling) Islands'),
('CH', 'CHE', '756', 'Switzerland'),
('CL', 'CHL', '152', 'Chile'),
('CN', 'CHN', '156', 'China'),
('CI', 'CIV', '384', 'Côte d''Ivoire'),
('CM', 'CMR', '120', 'Cameroon'),
('CD', 'COD', '180', 'Congo, The Democratic Republic of the'),
('CG', 'COG', '178', 'Congo'),
('CK', 'COK', '184', 'Cook Islands'),
('CO', 'COL', '170', 'Colombia'),
('KM', 'COM', '174', 'Comoros'),
('CV', 'CPV', '132', 'Cabo Verde'),
('CR', 'CRI', '188', 'Costa Rica'),
('CU', 'CUB', '192', 'Cuba'),
('CW', 'CUW', '531', 'Curaçao'),
('CX', 'CXR', '162', 'Christmas Island'),
('KY', 'CYM', '136', 'Cayman Islands'),
('CY', 'CYP', '196', 'Cyprus'),
('CZ', 'CZE', '203', 'Czechia'),
('DE', 'DEU', '276', 'Germany'),
('DJ', 'DJI', '262', 'Djibouti'),
('DM', 'DMA', '212', 'Dominica'),
('DK', 'DNK', '208', 'Denmark'),
('DO', 'DOM', '214', 'Dominican Republic'),
('DZ', 'DZA', '012', 'Algeria'),
('EC', 'ECU', '218', 'Ecuador'),
('EG', 'EGY', '818', 'Egypt'),
('ER', 'ERI', '232', 'Eritrea'),
('EH', 'ESH', '732', 'Western Sahara'),
('ES', 'ESP', '724', 'Spain'),
('EE', 'EST', '233', 'Estonia'),
('ET', 'ETH', '231', 'Ethiopia'),
('FI', 'FIN', '246', 'Finland'),
('FJ', 'FJI', '242', 'Fiji'),
('FK', 'FLK', '238', 'Falkland Islands (Malvinas)'),
('FR', 'FRA', '250', 'France'),
('FO', 'FRO', '234', 'Faroe Islands'),
('FM', 'FSM', '583', 'Micronesia, Federated States of'),
('GA', 'GAB', '266', 'Gabon'),
('GB', 'GBR', '826', 'United Kingdom'),
('GE', 'GEO', '268', 'Georgia'),
('GG', 'GGY', '831', 'Guernsey'),
('GH', 'GHA', '288', 'Ghana'),
('GI', 'GIB', '292', 'Gibraltar'),
('GN', 'GIN', '324', 'Guinea'),
('GP', 'GLP', '312', 'Guadeloupe'),
('GM', 'GMB', '270', 'Gambia'),
('GW', 'GNB', '624', 'Guinea-Bissau'),
('GQ', 'GNQ', '226', 'Equatorial Guinea'),
('GR', 'GRC', '300', 'Greece'),
('GD', 'GRD', '308', 'Grenada'),
('GL', 'GRL', '304', 'Greenland'),
('GT', 'GTM', '320', 'Guatemala'),
('GF', 'GUF', '254', 'French Guiana'),
('GU', 'GUM', '316', 'Guam'),
('GY', 'GUY', '328', 'Guyana'),
('HK', 'HKG', '344', 'Hong Kong'),
('HM', 'HMD', '334', 'Heard Island and McDonald Islands'),
('HN', 'HND', '340', 'Honduras'),
('HR', 'HRV', '191', 'Croatia'),
('HT', 'HTI', '332', 'Haiti'),
('HU', 'HUN', '348', 'Hungary'),
('ID', 'IDN', '360', 'Indonesia'),
('IM', 'IMN', '833', 'Isle of Man'),
('IN', 'IND', '356', 'India'),
('IO', 'IOT', '086', 'British Indian Ocean Territory'),
('IE', 'IRL', '372', 'Ireland'),
('IR', 'IRN', '364', 'Iran'),
('IQ', 'IRQ', '368', 'Iraq'),
('IS', 'ISL', '352', 'Iceland'),
('IL', 'ISR', '376', 'Israel'),
('IT', 'ITA', '380', 'Italy'),
('JM', 'JAM', '388', 'Jamaica'),
('JE', 'JEY', '832', 'Jersey'),
('JO', 'JOR', '400', 'Jordan'),
('JP', 'JPN', '392', 'Japan'),
('KZ', 'KAZ', '398', 'Kazakhstan'),
('KE', 'KEN', '404', 'Kenya'),
('KG', 'KGZ', '417', 'Kyrgyzstan'),
('KH', 'KHM', '116', 'Cambodia'),
('KI', 'KIR', '296', 'Kiribati'),
('KN', 'KNA', '659', 'Saint Kitts and Nevis'),
('KR', 'KOR', '410', 'South Korea'),
('KW', 'KWT', '414', 'Kuwait'),
('LA', 'LAO', '418', 'Laos'),
('LB', 'LBN', '422', 'Lebanon'),
('LR', 'LBR', '430', 'Liberia'),
('LY', 'LBY', '434', 'Libya'),
('LC', 'LCA', '662', 'Saint Lucia'),
('LI', 'LIE', '438', 'Liechtenstein'),
('LK', 'LKA', '144', 'Sri Lanka'),
('LS', 'LSO', '426', 'Lesotho'),
('LT', 'LTU', '440', 'Lithuania'),
('LU', 'LUX', '442', 'Luxembourg'),
('LV', 'LVA', '428', 'Latvia'),
('MO', 'MAC', '446', 'Macao'),
('MF', 'MAF', '663', 'Saint Martin (French part)'),
('MA', 'MAR', '504', 'Morocco'),
('MC', 'MCO', '492', 'Monaco'),
('MD', 'MDA', '498', 'Moldova'),
('MG', 'MDG', '450', 'Madagascar'),
('MV', 'MDV', '462', 'Maldives'),
('MX', 'MEX', '484', 'Mexico'),
('MH', 'MHL', '584', 'Marshall Islands'),
('MK', 'MKD', '807', 'North Macedonia'),
('ML', 'MLI', '466', 'Mali'),
('MT', 'MLT', '470', 'Malta'),
('MM', 'MMR', '104', 'Myanmar'),
('ME', 'MNE', '499', 'Montenegro'),
('MN', 'MNG', '496', 'Mongolia'),
('MP', 'MNP', '580', 'Northern Mariana Islands'),
('MZ', 'MOZ', '508', 'Mozambique'),
('MR', 'MRT', '478', 'Mauritania'),
('MS', 'MSR', '500', 'Montserrat'),
('MQ', 'MTQ', '474', 'Martinique'),
('MU', 'MUS', '480', 'Mauritius'),
('MW', 'MWI', '454', 'Malawi'),
('MY', 'MYS', '458', 'Malaysia'),
('YT', 'MYT', '175', 'Mayotte'),
('NA', 'NAM', '516', 'Namibia'),
('NC', 'NCL', '540', 'New Caledonia'),
('NE', 'NER', '562', 'Niger'),
('NF', 'NFK', '574', 'Norfolk Island'),
('NG', 'NGA', '566', 'Nigeria'),
('NI', 'NIC', '558', 'Nicaragua'),
('NU', 'NIU', '570', 'Niue'),
('NL', 'NLD', '528', 'Netherlands'),
('NO', 'NOR', '578', 'Norway'),
('NP', 'NPL', '524', 'Nepal'),
('NR', 'NRU', '520', 'Nauru'),
('NZ', 'NZL', '554', 'New Zealand'),
('OM', 'OMN', '512', 'Oman'),
('PK', 'PAK', '586', 'Pakistan'),
('PA', 'PAN', '591', 'Panama'),
('PN', 'PCN', '612', 'Pitcairn'),
('PE', 'PER', '604', 'Peru'),
('PH', 'PHL', '608', 'Philippines'),
('PW', 'PLW', '585', 'Palau'),
('PG', 'PNG', '598', 'Papua New Guinea'),
('PL', 'POL', '616', 'Poland'),
('PR', 'PRI', '630', 'Puerto Rico'),
('KP', 'PRK', '408', 'North Korea'),
('PT', 'PRT', '620', 'Portugal'),
('PY', 'PRY', '600', 'Paraguay'),
('PS', 'PSE', '275', 'Palestine, State of'),
('PF', 'PYF', '258', 'French Polynesia'),
('QA', 'QAT', '634', 'Qatar'),
('RE', 'REU', '638', 'Réunion'),
('RO', 'ROU', '642', 'Romania'),
('RU', 'RUS', '643', 'Russian Federation'),
('RW', 'RWA', '646', 'Rwanda'),
('SA', 'SAU', '682', 'Saudi Arabia'),
('SD', 'SDN', '729', 'Sudan'),
('SN', 'SEN', '686', 'Senegal'),
('SG', 'SGP', '702', 'Singapore'),
('GS', 'SGS', '239', 'South Georgia and the South Sandwich Islands'),
('SH', 'SHN', '654', 'Saint Helena, Ascension and Tristan da Cunha'),
('SJ', 'SJM', '744', 'Svalbard and Jan Mayen'),
('SB', 'SLB', '090', 'Solomon Islands'),
('SL', 'SLE', '694', 'Sierra Leone'),
('SV', 'SLV', '222', 'El Salvador'),
('SM', 'SMR', '674', 'San Marino'),
('SO', 'SOM', '706', 'Somalia'),
('PM', 'SPM', '666', 'Saint Pierre and Miquelon'),
('RS', 'SRB', '688', 'Serbia'),
('SS', 'SSD', '728', 'South Sudan'),
('ST', 'STP', '678', 'Sao Tome and Principe'),
('SR', 'SUR', '740', 'Suriname'),
('SK', 'SVK', '703', 'Slovakia'),
('SI', 'SVN', '705', 'Slovenia'),
('SE', 'SWE', '752', 'Sweden'),
('SZ', 'SWZ', '748', 'Eswatini'),
('SX', 'SXM', '534', 'Sint Maarten (Dutch part)'),
('SC', 'SYC', '690', 'Seychelles'),
('SY', 'SYR', '760', 'Syria'),
('TC', 'TCA', '796', 'Turks and Caicos Islands'),
('TD', 'TCD', '148', 'Chad'),
('TG', 'TGO', '768', 'Togo'),
('TH', 'THA', '764', 'Thailand'),
('TJ', 'TJK', '762', 'Tajikistan'),
('TK', 'TKL', '772', 'Tokelau'),
('TM', 'TKM', '795', 'Turkmenistan'),
('TL', 'TLS', '626', 'Timor-Leste'),
('TO', 'TON', '776', 'Tonga'),
('TT', 'TTO', '780', 'Trinidad and Tobago'),
('TN', 'TUN', '788', 'Tunisia'),
('TR', 'TUR', '792', 'Türkiye'),
('TV', 'TUV', '798', 'Tuvalu'),
('TW', 'TWN', '158', 'Taiwan'),
('TZ', 'TZA', '834', 'Tanzania'),
('UG', 'UGA', '800', 'Uganda'),
('UA', 'UKR', '804', 'Ukraine'),
('UM', 'UMI', '581', 'United States Minor Outlying Islands'),
('UY', 'URY', '858', 'Uruguay'),
('US', 'USA', '840', 'United States'),
('UZ', 'UZB', '860', 'Uzbekistan'),
('VA', 'VAT', '336', 'Holy See (Vatican City State)'),
('VC', 'VCT', '670', 'Saint Vincent and the Grenadines'),
('VE', 'VEN', '862', 'Venezuela'),
('VG', 'VGB', '092', 'Virgin Islands, British'),
('VI', 'VIR', '850', 'Virgin Islands, U.S.'),
('VN', 'VNM', '704', 'Vietnam'),
('VU', 'VUT', '548', 'Vanuatu'),
('WF', 'WLF', '876', 'Wallis and Futuna'),
('WS', 'WSM', '882', 'Samoa'),
('YE', 'YEM', '887', 'Yemen'),
('ZA', 'ZAF', '710', 'South Africa'),
('ZM', 'ZMB', '894', 'Zambia'),
('ZW', 'ZWE', '716', 'Zimbabwe');


INSERT INTO tax_jurisdiction (code, country_code, name, authority, valid_from) VALUES
  ('GB-HMRC', 'GB', 'United Kingdom', 'HM Revenue & Customs', '1970-01-01'),
  ('IE-REV', 'IE', 'Ireland', 'Revenue Commissioners', '1970-01-01');

-- Runtime role: read-only. Changes to reference data are migrations.
GRANT SELECT ON "currency", "country", "tax_jurisdiction" TO uk_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "currency", "country", "tax_jurisdiction" FROM uk_app;

-- ───────── Company profile ─────────
ALTER TABLE company ADD COLUMN "incorporation_date" DATE;
ALTER TABLE company ADD COLUMN "year_end_month" SMALLINT;
ALTER TABLE company ADD COLUMN "year_end_day" SMALLINT;
ALTER TABLE company ADD COLUMN "base_currency" CHAR(3) NOT NULL DEFAULT 'GBP';
ALTER TABLE company ADD COLUMN "country_code" CHAR(2) NOT NULL DEFAULT 'GB';
ALTER TABLE company ADD COLUMN "tax_jurisdiction_code" TEXT;
ALTER TABLE company ADD CONSTRAINT company_year_end_ck CHECK (
  (year_end_month IS NULL AND year_end_day IS NULL)
  OR (year_end_month IS NOT NULL AND year_end_day IS NOT NULL AND year_end_month BETWEEN 1 AND 12 AND year_end_day >= 1 AND year_end_day <= (ARRAY[31,29,31,30,31,30,31,31,30,31,30,31])[year_end_month]));
ALTER TABLE company ADD CONSTRAINT "company_base_currency_fkey" FOREIGN KEY ("base_currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE company ADD CONSTRAINT "company_country_code_fkey" FOREIGN KEY ("country_code") REFERENCES "country"("alpha2") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A jurisdiction CODE is not unique over time, so it cannot be a foreign key: check that some definition of it exists.
CREATE OR REPLACE FUNCTION company_tax_jurisdiction_exists() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tax_jurisdiction_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tax_jurisdiction j WHERE j.code = NEW.tax_jurisdiction_code) THEN
    RAISE EXCEPTION 'unknown tax jurisdiction %', NEW.tax_jurisdiction_code USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_tax_jurisdiction_trg BEFORE INSERT OR UPDATE OF tax_jurisdiction_code ON company
  FOR EACH ROW EXECUTE FUNCTION company_tax_jurisdiction_exists();

-- ───────── Contacts ─────────
CREATE TABLE "contact" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID,
    "kind" "ContactKind" NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "reference" TEXT,
    "labels" TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
    "notes" TEXT,
    "status" "ContactStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT contact_name_ck CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
    CONSTRAINT contact_email_ck CHECK (email IS NULL OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
    CONSTRAINT contact_labels_ck CHECK (cardinality(labels) <= 10)
);
CREATE UNIQUE INDEX "contact_organisation_id_id_key" ON "contact"("organisation_id", "id");
CREATE INDEX "contact_organisation_id_company_id_idx" ON "contact"("organisation_id", "company_id");
CREATE INDEX "contact_organisation_id_name_idx" ON "contact"("organisation_id", lower("name"));
ALTER TABLE "contact" ADD CONSTRAINT "contact_organisation_id_company_id_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contact" ADD CONSTRAINT "contact_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────── Addresses (owned by exactly one company OR one contact) ─────────
CREATE TABLE "address" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID,
    "contact_id" UUID,
    "kind" "AddressKind" NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "line3" TEXT,
    "city" TEXT NOT NULL,
    "region" TEXT,
    "postcode" TEXT,
    "country_code" CHAR(2) NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "address_pkey" PRIMARY KEY ("id"),
    CONSTRAINT address_one_owner_ck CHECK ((company_id IS NOT NULL) <> (contact_id IS NOT NULL)),
    CONSTRAINT address_line1_ck CHECK (char_length(btrim(line1)) BETWEEN 1 AND 200),
    CONSTRAINT address_gb_postcode_ck CHECK (country_code <> 'GB' OR postcode IS NULL OR upper(postcode) ~ '^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$')
);
CREATE INDEX "address_organisation_id_company_id_idx" ON "address"("organisation_id", "company_id");
CREATE INDEX "address_organisation_id_contact_id_idx" ON "address"("organisation_id", "contact_id");
CREATE UNIQUE INDEX "address_company_primary_uq" ON "address"("company_id", "kind") WHERE is_primary AND company_id IS NOT NULL;
CREATE UNIQUE INDEX "address_contact_primary_uq" ON "address"("contact_id", "kind") WHERE is_primary AND contact_id IS NOT NULL;
ALTER TABLE "address" ADD CONSTRAINT "address_organisation_id_company_id_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "address" ADD CONSTRAINT "address_organisation_id_contact_id_fkey" FOREIGN KEY ("organisation_id", "contact_id") REFERENCES "contact"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "address" ADD CONSTRAINT "address_country_code_fkey" FOREIGN KEY ("country_code") REFERENCES "country"("alpha2") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Directors / officers (history is kept: an officer resigns, the row stays) ─────────
CREATE TABLE "company_officer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "role" "OfficerRole" NOT NULL,
    "appointed_on" DATE NOT NULL,
    "resigned_on" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "company_officer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT officer_dates_ck CHECK (resigned_on IS NULL OR resigned_on >= appointed_on)
);
CREATE UNIQUE INDEX "company_officer_company_id_contact_id_role_appointed_on_key" ON "company_officer"("company_id", "contact_id", "role", "appointed_on");
CREATE INDEX "company_officer_organisation_id_company_id_idx" ON "company_officer"("organisation_id", "company_id");
CREATE INDEX "company_officer_organisation_id_contact_id_idx" ON "company_officer"("organisation_id", "contact_id");
ALTER TABLE "company_officer" ADD CONSTRAINT "company_officer_organisation_id_company_id_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "company_officer" ADD CONSTRAINT "company_officer_organisation_id_contact_id_fkey" FOREIGN KEY ("organisation_id", "contact_id") REFERENCES "contact"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- The officer's contact must be organisation-level or belong to the same company.
CREATE OR REPLACE FUNCTION officer_contact_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c_company uuid; c_found boolean;
BEGIN
  SELECT company_id, true INTO c_company, c_found FROM contact WHERE organisation_id = NEW.organisation_id AND id = NEW.contact_id;
  IF NOT coalesce(c_found, false) THEN RAISE EXCEPTION 'officer contact not found' USING ERRCODE = '23503'; END IF;
  IF c_company IS NOT NULL AND c_company <> NEW.company_id THEN
    RAISE EXCEPTION 'an officer contact must be organisation-level or belong to the same company' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER officer_contact_scope_trg BEFORE INSERT OR UPDATE OF contact_id, company_id ON company_officer
  FOR EACH ROW EXECUTE FUNCTION officer_contact_scope();

-- ───────── Row-level security on the tenant tables (fail closed) ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contact','address','company_officer']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO uk_app', t);
  END LOOP;
END $$;

-- ───────── System roles gain contact:read / contact:manage ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = ARRAY['org:read','org:manage','member:read','member:invite','member:manage','role:read','role:manage','company:read','company:create','company:update','period:read','period:manage','document:read','document:upload','document:archive','audit:read','job:read','job:manage','task:read','task:manage','workflow:read','workflow:manage','integration:read','integration:manage','ai:use','ai:approve','practice:read','practice:manage','practice:member:manage','company:access:manage','workflow:review','workflow:approve','contact:read','contact:manage']::text[] WHERE organisation_id IS NULL AND key = 'owner';
UPDATE "role" SET permissions = ARRAY['org:read','member:read','member:invite','member:manage','role:read','role:manage','company:read','company:create','company:update','period:read','period:manage','document:read','document:upload','document:archive','audit:read','job:read','job:manage','task:read','task:manage','workflow:read','workflow:manage','integration:read','integration:manage','ai:use','ai:approve','practice:read','practice:manage','practice:member:manage','company:access:manage','workflow:review','workflow:approve','contact:read','contact:manage']::text[] WHERE organisation_id IS NULL AND key = 'admin';
UPDATE "role" SET permissions = ARRAY['org:read','member:read','role:read','job:read','practice:read','practice:manage','practice:member:manage','company:create','company:read','company:update','period:read','period:manage','document:read','document:upload','document:archive','audit:read','task:read','task:manage','workflow:read','workflow:manage','ai:use','ai:approve','company:access:manage','workflow:review','workflow:approve','contact:read','contact:manage']::text[] WHERE organisation_id IS NULL AND key = 'partner';
UPDATE "role" SET permissions = ARRAY['org:read','member:read','role:read','job:read','practice:read','company:read','company:update','period:read','period:manage','document:read','document:upload','document:archive','task:read','task:manage','workflow:read','workflow:manage','workflow:review','ai:use','contact:read','contact:manage']::text[] WHERE organisation_id IS NULL AND key = 'manager';
UPDATE "role" SET permissions = ARRAY['org:read','member:read','role:read','company:read','period:read','document:read','practice:read','company:create','company:update','period:manage','document:upload','document:archive','job:read','audit:read','task:read','task:manage','workflow:read','workflow:manage','workflow:review','ai:use','ai:approve','contact:read','contact:manage']::text[] WHERE organisation_id IS NULL AND key = 'accountant';
UPDATE "role" SET permissions = ARRAY['org:read','member:read','role:read','company:read','period:read','document:read','practice:read','document:upload','job:read','task:read','task:manage','workflow:read','ai:use','contact:read','contact:manage']::text[] WHERE organisation_id IS NULL AND key = 'bookkeeper';
UPDATE "role" SET permissions = ARRAY['org:read','member:read','role:read','company:read','period:read','document:read','practice:read','audit:read','job:read','task:read','workflow:read','workflow:review','contact:read']::text[] WHERE organisation_id IS NULL AND key = 'reviewer';
UPDATE "role" SET permissions = ARRAY['org:read','company:read','period:read','document:read']::text[] WHERE organisation_id IS NULL AND key = 'client_viewer';
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

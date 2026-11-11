export interface CategoryRef {majorCode:string;minorCode:string|null;dictionaryVersion:string}
export interface DictionaryType {code:string;name:string;status:'enabled'|'disabled';version:number;published:boolean;readOnly:boolean;fixedCodes:boolean}
export interface DictionaryItem {itemId:string;typeCode:string;code:string;label:string;parentCode:string|null;sort:number;status:'enabled'|'disabled';version:number;published:boolean}
export interface CategoryRevision {revisionId:string;oldMajorCode:string|null;oldMinorCode:string|null;oldDictionaryVersion:string|null;majorCode:string;minorCode:string|null;dictionaryVersion:string;editVersion:number;createdAt:string}
